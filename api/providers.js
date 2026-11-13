export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    providers: [
      {
        id: "gateway",
        name: "Vercel AI Gateway (principal)",
        configured: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
        model: process.env.AI_GATEWAY_MODEL || "moonshotai/kimi-k3",
      },
      {
        id: "openai",
        name: "OpenAI (fallback opcional)",
        configured: Boolean(process.env.OPENAI_API_KEY),
      },
      {
        id: "gemini",
        name: "Google Gemini (fallback opcional)",
        configured: Boolean(process.env.GEMINI_API_KEY),
      },
      {
        id: "anthropic",
        name: "Claude (fallback opcional)",
        configured: Boolean(process.env.ANTHROPIC_API_KEY),
      },
    ],
  });
}
