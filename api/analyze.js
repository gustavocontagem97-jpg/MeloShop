export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"Método não permitido."});
  res.setHeader("Content-Type","application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control","no-cache, no-transform");
  res.setHeader("X-Accel-Buffering","no");
  const send = x => res.write(JSON.stringify(x)+"\n");
  try {
    const b=req.body||{}, url=typeof b.url==="string"?b.url.trim():"";
    let u; try { u=new URL(url); } catch { throw new Error("Cole um link válido do produto."); }
    const domains=["shopee.com.br","mercadolivre.com.br","mercadolibre.com","amazon.com.br","aliexpress.com"];
    if(u.protocol!=="https:"||u.username||u.password||!domains.some(d=>u.hostname===d||u.hostname.endsWith("."+d))){
      res.status(400); send({type:"error",error:"Use um link HTTPS da Shopee, Mercado Livre, Amazon Brasil ou AliExpress."}); return res.end();
    }
    send({type:"progress",stage:"validate",message:"Link validado. Preparando a pesquisa..."});
    let page={title:"",description:"",text:"",read:false};
    try {
      const r=await fetch(u.toString(),{headers:{"User-Agent":"Mozilla/5.0 (compatible; MeloShop/1.1)","Accept-Language":"pt-BR,pt;q=0.9"},signal:AbortSignal.timeout(8000),redirect:"manual"});
      if(r.ok&&(r.headers.get("content-type")||"").includes("text/html")){
        const html=(await r.text()).slice(0,350000);
        const meta=k=>{const tags=html.match(/<meta\b[^>]*>/gi)||[];for(const t of tags){const n=(t.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)||[])[1];const v=(t.match(/\bcontent\s*=\s*["']([^"']*)["']/i)||[])[1];if(n&&n.toLowerCase()===k.toLowerCase()&&v)return v;}return "";};
        const title=meta("og:title")||((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"");
        const description=meta("og:description")||meta("description");
        const text=html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").slice(0,14000);
        page={title:title.slice(0,500),description:description.slice(0,1200),text,read:true};
      }
    } catch { page.read_error="A loja limitou a leitura automática ou demorou a responder."; }
    send({type:"progress",stage:"research",message:page.read?"Página pública lida. Enviando dados para pesquisa com IA...":"A loja limitou a leitura automática. A IA vai tentar pesquisar pelo link..."});
    const prompt=[
      "Você é especialista de marketing do MeloShop. Identifique o produto pelo link e dados. Use pesquisa web quando disponível. Nunca invente dados. Se não identificar, diga o que falta.",
      "LINK: "+u.toString(),
      "DADOS EXTRAÍDOS: "+JSON.stringify(page),
      "CANAL: "+(b.channel||"Todas as redes")+". TOM: "+(b.tone||"vendedor")+". OBSERVAÇÕES: "+(typeof b.extra==="string"?b.extra.slice(0,1200):""),
      "Responda SOMENTE JSON válido: {product:{name,category,price,benefits,source},content:{hook,title,summary,benefits,caption,hashtags,video_script,video_prompt,social_posts,cta,visual_direction,research_notes}}.",
      "Preço só se confirmado; caso contrário 'Não confirmado'. benefits e hashtags são arrays. Hashtags 8-15 relevantes, não afirme que são tendências atuais.",
      "video_script objeto com objective,audience,duration_seconds (15,20 ou 30),format ('Vertical 9:16'),style,audio_direction,scenes. Faça 4-7 cenas com time,shot,visual,on_screen_text,voiceover,transition. Abertura forte nos 2 segundos iniciais, demonstração, 2-3 benefícios confirmados e CTA. Roteiro completo, específico, natural, informativo, sem enrolação nem repetição. Se faltarem dados, não invente cenas ou características.",
      "video_prompt é prompt completo para gerador externo: 9:16, duração, estética, sequência, enquadramentos, movimentos, iluminação, ritmo e instrução para não inventar textos, logotipos, preços ou características.",
      "social_posts objeto com Instagram,TikTok,Facebook,WhatsApp, textos próprios para cada canal. research_notes separa fatos confirmados, não confirmados e fontes. Português brasileiro. Não gere imagem ou vídeo."
    ].join("\n");
    send({type:"progress",stage:"ai",message:"Consultando as IAs conectadas e montando o anúncio..."});
    const ps=[["openai",process.env.OPENAI_API_KEY],["gemini",process.env.GEMINI_API_KEY],["anthropic",process.env.ANTHROPIC_API_KEY]].filter(x=>x[1]);
    if(!ps.length){res.status(503);send({type:"error",error:"Nenhuma IA conectada no servidor. Configure OPENAI_API_KEY, GEMINI_API_KEY ou ANTHROPIC_API_KEY nas variáveis do projeto na Vercel."});return res.end();}
    const errors=[];
    for(const [name,key] of ps){
      try{
        let raw=await callProvider(name,key,prompt);
        const tick=String.fromCharCode(96), fence=tick.repeat(3);
        if(raw.startsWith(fence)){raw=raw.slice(raw.indexOf("\n")+1);const endFence=raw.lastIndexOf(fence);if(endFence>=0)raw=raw.slice(0,endFence);}
        const s=raw.indexOf("{"),e=raw.lastIndexOf("}");
        if(s<0||e<0)throw new Error("A IA não retornou JSON.");
        const data=JSON.parse(raw.slice(s,e+1));
        if(!data.content)throw new Error("Resposta veio sem conteúdo.");
        send({type:"progress",stage:"format",message:"Resposta recebida. Organizando roteiro, hashtags e publicações..."});
        send({type:"result",product:data.product||{},content:data.content,provider_used:name});return res.end();
      }catch(e){errors.push(name+": "+(e.message||"falha"));}
    }
    res.status(502);send({type:"error",error:"As IAs configuradas não concluíram a análise. "+errors.join(" | ")});return res.end();
  }catch(e){if(!res.headersSent)res.status(500);send({type:"error",error:e.message||"Erro ao analisar produto."});return res.end();}
}
async function callProvider(name,key,prompt){
  const signal=AbortSignal.timeout(22000);
  if(name==="openai"){
    const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},signal,body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-5-mini",reasoning:{effort:"low"},tools:[{type:"web_search"}],input:prompt})});
    const j=await r.json();if(!r.ok)throw new Error(j.error?.message||"Erro OpenAI");
    const t=j.output_text||(j.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||"").join("\n");if(!t)throw new Error("OpenAI retornou vazio.");return t;
  }
  if(name==="gemini"){
    const model=process.env.GEMINI_MODEL||"gemini-2.5-flash";
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+":generateContent?key="+encodeURIComponent(key),{method:"POST",headers:{"Content-Type":"application/json"},signal,body:JSON.stringify({contents:[{parts:[{text:prompt}]}],tools:[{google_search:{}}]})});
    const j=await r.json();if(!r.ok)throw new Error(j.error?.message||"Erro Gemini");
    const t=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("\n");if(!t)throw new Error("Gemini retornou vazio.");return t;
  }
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","Content-Type":"application/json"},signal,body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||"claude-haiku-5-5",max_tokens:5000,tools:[{type:"web_search_20250305",name:"web_search",max_uses:3}],messages:[{role:"user",content:prompt}]})});
  const j=await r.json();if(!r.ok)throw new Error(j.error?.message||"Erro Claude");
  const t=(j.content||[]).filter(c=>c.type==="text").map(c=>c.text||"").join("\n");if(!t)throw new Error("Claude retornou vazio.");return t;
}