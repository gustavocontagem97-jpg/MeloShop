export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ providers: [
    { id: "openai", name: "OpenAI", configured: Boolean(process.env.OPENAI_API_KEY) },
    { id: "gemini", name: "Google Gemini", configured: Boolean(process.env.GEMINI_API_KEY) },
    { id: "anthropic", name: "Claude (Anthropic)", configured: Boolean(process.env.ANTHROPIC_API_KEY) }
  ] });
}