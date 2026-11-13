const ALLOWED_DOMAINS = [
  "shopee.com.br",
  "meli.la",
  "mercadolivre.com.br",
  "mercadolibre.com",
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_HTML_BYTES = 1_000_000;
const MAX_TEXT_LENGTH = 6_000;

function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ALLOWED_DOMAINS.some(domain => host === domain || host.endsWith("." + domain));
}

export function parseProductUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new Error("Cole um link de produto válido.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("O link informado não é válido.");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !isAllowedHost(url.hostname)
  ) {
    throw new Error("Use um link HTTPS da Shopee ou do Mercado Livre.");
  }

  url.hash = "";
  return url;
}

export function marketplaceName(url) {
  const host = typeof url === "string" ? new URL(url).hostname : url.hostname;
  return host === "meli.la" || host.endsWith(".meli.la") ||
    host === "mercadolivre.com.br" ||
    host.endsWith(".mercadolivre.com.br") ||
    host === "mercadolibre.com" ||
    host.endsWith(".mercadolibre.com")
    ? "Mercado Livre"
    : "Shopee";
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attributes;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => (Number(code) >= 0 && Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : ""))
    .replace(/&#x([\da-f]+);/gi, (_, code) => (parseInt(code, 16) >= 0 && parseInt(code, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(code, 16)) : ""));
}

function collectProductObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectProductObjects(item, output);
    return output;
  }

  if (!value || typeof value !== "object") return output;

  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some(type => String(type || "").toLowerCase() === "product")) {
    output.push(value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectProductObjects(child, output);
  }

  return output;
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== "") ?? "";
}

export function extractProductMetadata(html) {
  const meta = Object.create(null);

  for (const match of String(html || "").matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    const key = String(attributes.property || attributes.name || "").toLowerCase();
    if (key && attributes.content) meta[key] = decodeHtml(attributes.content);
  }

  let titleTag = "";
  const titleMatch = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) titleTag = decodeHtml(titleMatch[1].replace(/<[^>]+>/g, " ")).trim();

  const products = [];
  for (const match of String(html || "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (String(attributes.type || "").toLowerCase() !== "application/ld+json") continue;

    try {
      const parsed = JSON.parse(match[2].trim());
      collectProductObjects(parsed, products);
    } catch {
      // Invalid JSON-LD is ignored; Open Graph metadata remains available.
    }
  }

  const product = products[0] || {};
  const offers = Array.isArray(product.offers) ? product.offers[0] || {} : product.offers || {};
  const brand = typeof product.brand === "string" ? product.brand : product.brand?.name || "";
  const imageValue = Array.isArray(product.image) ? product.image[0] : product.image;
  const image = typeof imageValue === "string" ? imageValue : imageValue?.url || "";

  const plainText = decodeHtml(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();

  return {
    title: firstValue(meta["og:title"], meta["twitter:title"], titleTag),
    description: firstValue(meta["og:description"], meta.description, meta["twitter:description"], product.description),
    image: firstValue(meta["og:image"], meta["twitter:image"], image),
    price: firstValue(meta["product:price:amount"], meta["og:price:amount"], offers.price),
    currency: firstValue(meta["product:price:currency"], meta["og:price:currency"], offers.priceCurrency, "BRL"),
    brand,
    category: typeof product.category === "string" ? product.category : "",
    sku: typeof product.sku === "string" ? product.sku : "",
    availability: typeof offers.availability === "string" ? offers.availability : "",
    structuredProduct: products.length ? {
      name: product.name || "",
      brand,
      category: typeof product.category === "string" ? product.category : "",
      sku: typeof product.sku === "string" ? product.sku : "",
      price: offers.price ?? "",
      currency: offers.priceCurrency || "",
      availability: typeof offers.availability === "string" ? offers.availability : "",
    } : null,
    text: plainText.slice(0, MAX_TEXT_LENGTH),
  };
}

async function readHtmlLimited(response) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = MAX_HTML_BYTES - totalBytes;
      if (value.byteLength > remaining) {
        output += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
        try { await reader.cancel(); } catch {}
        break;
      }

      totalBytes += value.byteLength;
      output += decoder.decode(value, { stream: true });
    }

    output += decoder.decode();
    return output;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export async function readProductPage(input, fetchImpl = fetch) {
  const initialUrl = parseProductUrl(input);
  let currentUrl = initialUrl;
  const signal = AbortSignal.timeout(5_000);

  try {
    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      const response = await fetchImpl(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MeloShop/2.0; +https://github.com/gustavocontagem97-jpg/MeloShop)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        try { await response.body?.cancel(); } catch {}
        if (!location) throw new Error("A loja redirecionou sem informar o destino.");
        if (redirectCount === 4) throw new Error("A loja enviou redirecionamentos demais.");
        currentUrl = parseProductUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if (!response.ok) throw new Error("A loja respondeu com HTTP " + response.status + ".");
      const contentType = response.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new Error("A página não retornou conteúdo HTML de produto.");
      }

      const html = await readHtmlLimited(response);
      const metadata = extractProductMetadata(html);

      return {
        platform: marketplaceName(currentUrl),
        sourceUrl: currentUrl.toString(),
        read: true,
        ...metadata,
      };
    }

    throw new Error("Não foi possível concluir os redirecionamentos.");
  } catch {
    return {
      platform: marketplaceName(initialUrl),
      sourceUrl: currentUrl.toString(),
      read: false,
      read_error: "A loja limitou a leitura automática, bloqueou o acesso ou demorou para responder. Informe nome, preço e características na observação para melhorar o resultado.",
      title: "",
      description: "",
      image: "",
      price: "",
      currency: "BRL",
      brand: "",
      category: "",
      sku: "",
      availability: "",
      structuredProduct: null,
      text: "",
    };
  }
}
