export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
  try {
    const { url, channel = "Todas as redes", tone = "vendedor", extra = "" } = req.body || {};
    const parsed = new URL(url);
    const allowed = ["shopee.com.br", "mercadolivre.com.br", "mercadolibre.com", "amazon.com.br", "aliexpress.com"];
    if (parsed.protocol !== "https:" || !allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith("." + d))) {
      return res.status(400).json({ error: "Use um link HTTPS da Shopee, Mercado Livre, Amazon Brasil ou AliExpress." });
    }
    let page = { title: "", description: "", text: "A loja pode bloquear a leitura automática. A IA também pesquisará pelo link." };
    try {
      const response = await fetch(parsed.toString(), { headers: { "User-Agent": "Mozilla/5.0 (compatible; MeloShop/1.0)", "Accept-Language": "pt-BR,pt;q=0.9" }, signal: AbortSignal.timeout(9000), redirect: "manual" });
      if (response.ok) {
        const html = (await response.text()).slice(0, 350000);
        const meta = key => { const re = new RegExp('<meta[^>]+(?:property|name)="'+key+'"[^>]+content="([^"]*)"[^>]*>', "i"); const m = html.match(re); return m ? m[1] : ""; };
        const title = meta("og:title") || ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
        const description = meta("og:description") || meta("description");
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 16000);
        page = { title, description, text };
      }
    } catch {}
    const prompt = [
      "Você é o especialista de marketing do MeloShop. Analise o produto pelo link e pelos dados abaixo. Pesquise na web se a ferramenta estiver disponível. Nunca invente preço, estoque, avaliações ou características; se não confirmar, indique isso.",
      "LINK: " + parsed.toString(),
      "DADOS DA PÁGINA: " + JSON.stringify(page),
      "CANAIS: " + channel + ". TOM: " + tone + ". OBSERVAÇÃO: " + extra,
      "Crie um roteiro de anúncio realmente profissional, específico para ESTE produto, não um texto genérico. Responda somente JSON válido com product:{name,category,price,benefits,source} e content:{hook,title,summary,benefits,caption,hashtags,video_script,video_prompt,social_posts,cta,visual_direction,research_notes}. hashtags e benefits são arrays. video_script é um objeto com: objective (objetivo do vídeo), audience (público provável sem presumir dados pessoais), duration_seconds (escolha 15, 20 ou 30 segundos conforme o produto), format (9:16 vertical), style (estética), audio_direction (música/sons sugeridos sem citar músicas protegidas), scenes (array de 4 a 7 cenas). Cada cena contém time (intervalo em segundos), shot (tipo de enquadramento e movimento de câmera), visual (o que aparece e o que acontece), on_screen_text (texto curto na tela), voiceover (fala natural do narrador) e transition (transição para a próxima cena). O roteiro deve ter: abertura forte nos primeiros 2 segundos; demonstração visual do produto em uso quando possível; 2 ou 3 benefícios comprováveis; fechamento com CTA claro. Inclua ritmo, pausas e uma progressão lógica; evite repetir a mesma frase entre narração e texto na tela. Adapte o roteiro ao produto real, não invente cenas que dependam de características não confirmadas. video_prompt é um prompt completo pronto para colar em gerador de vídeo, com proporção 9:16, duração, identidade visual, sequência de cenas, movimentos, iluminação, ritmo e instrução para não criar textos/logotipos ilegíveis; deixe espaços para inserir preço apenas se confirmado. social_posts deve ser objeto com Instagram, TikTok, Facebook e WhatsApp, cada canal com texto próprio. Escreva em português brasileiro natural, profissional e persuasivo, sem exageros. Não invente desconto, preço, estoque, garantia, material, medidas, avaliações ou benefícios. Quando faltar dado, sinalize. Em research_notes separe fatos confirmados, pontos não confirmados e fontes. Não gere imagens."
    ].join("\n");
    const providers = [["openai", process.env.OPENAI_API_KEY], ["gemini", process.env.GEMINI_API_KEY], ["anthropic", process.env.ANTHROPIC_API_KEY]].filter(p => p[1]);
    if (!providers.length) return res.status(503).json({ error: "Nenhuma IA conectada. Configure OPENAI_API_KEY, GEMINI_API_KEY ou ANTHROPIC_API_KEY nas variáveis do servidor." });
    const errors = [];
    for (const [name, key] of providers) {
      try {
        const raw = await callProvider(name, key, prompt);
        const cleaned = raw.replace(/^\`\`\`json\s*/i, "").replace(/\`\`\`$/i, "").trim();
        const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
        if (start < 0 || end < 0) throw new Error("Resposta sem JSON");
        const data = JSON.parse(cleaned.slice(start, end + 1));
        data.provider_used = name;
        return res.status(200).json(data);
      } catch (e) { errors.push(name + ": " + e.message); }
    }
    return res.status(502).json({ error: "As IAs configuradas não responderam. " + errors.join(" | ") });
  } catch (e) { return res.status(500).json({ error: e.message || "Erro ao analisar produto." }); }
}
async function callProvider(name, key, prompt) {
  if (name === "openai") {
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-5-mini", tools: [{ type: "web_search" }], input: prompt }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || "OpenAI API");
    return j.output_text || (j.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("\n");
  }
  if (name === "gemini") {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || "Gemini API");
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || "Claude API");
  return (j.content || []).map(c => c.text || "").join("\n");
}