import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProductUrl,
  marketplaceName,
  extractProductMetadata,
  readProductPage,
} from "../lib/product-research.js";

test("accepts supported Shopee and Mercado Livre HTTPS links", () => {
  assert.equal(parseProductUrl("https://shopee.com.br/product/123").hostname, "shopee.com.br");
  assert.equal(parseProductUrl("https://s.shopee.com.br/abc").hostname, "s.shopee.com.br");
  assert.equal(parseProductUrl("https://meli.la/abc").hostname, "meli.la");
  assert.equal(marketplaceName("https://www.mercadolivre.com.br/item/MLB123456789"), "Mercado Livre");
});

test("rejects insecure, unsupported and deceptive links", () => {
  assert.throws(() => parseProductUrl("http://shopee.com.br/item"));
  assert.throws(() => parseProductUrl("https://shopee.com.br.attacker.example/item"));
  assert.throws(() => parseProductUrl("https://user:pass@shopee.com.br/item"));
  assert.throws(() => parseProductUrl("https://example.com/item"));
});

test("extracts Open Graph metadata and Product JSON-LD", () => {
  const html = `
    <html><head>
      <meta content="Fone Bluetooth" property="og:title">
      <meta name="description" content="Fone sem fio para uso diário">
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"Fone Bluetooth",
         "brand":{"@type":"Brand","name":"Marca X"},"category":"Áudio",
         "sku":"ABC-123","offers":{"price":"89.90","priceCurrency":"BRL",
         "availability":"https://schema.org/InStock"}}
      </script>
    </head><body><h1>Fone Bluetooth</h1></body></html>
  `;

  const data = extractProductMetadata(html);
  assert.equal(data.title, "Fone Bluetooth");
  assert.equal(data.description, "Fone sem fio para uso diário");
  assert.equal(data.brand, "Marca X");
  assert.equal(data.price, "89.90");
  assert.equal(data.currency, "BRL");
  assert.equal(data.sku, "ABC-123");
  assert.match(data.text, /Fone Bluetooth/);
});

test("follows only redirects that remain inside approved marketplaces", async () => {
  const requested = [];
  const fakeFetch = async url => {
    requested.push(url);
    if (url === "https://meli.la/short") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://www.mercadolivre.com.br/item/MLB123456789" },
      });
    }
    return new Response('<html><head><meta property="og:title" content="Produto teste"></head></html>', {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  const result = await readProductPage("https://meli.la/short", fakeFetch);
  assert.equal(result.read, true);
  assert.equal(result.title, "Produto teste");
  assert.equal(requested.length, 2);
});

test("does not follow redirects to unapproved hosts", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://example.com/collect" },
    });
  };

  const result = await readProductPage("https://meli.la/short", fakeFetch);
  assert.equal(result.read, false);
  assert.equal(calls, 1);
});
