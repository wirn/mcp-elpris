import "dotenv/config";
import express, { Request, Response } from "express";
import { GoogleGenerativeAI, Tool } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PRIMARY_MODEL = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK ?? "gemini-1.5-flash-8b";

// ---- Express setup ----
const app = express();
app.use(express.json());

// ---- Hjälpare: kör MCP-verktyg via din /mcp-endpoint ----
async function callMcpGetPrices(args: {
  date?: string;
  area?: "SE1" | "SE2" | "SE3" | "SE4";
}) {
  // SDK:t sköter mcp-protocol-version, Accept, osv.
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:3000/mcp")
  );
  const client = new Client({ name: "elpris-chat-server", version: "0.1.0" });

  await client.connect(transport);

  const res = await client.callTool({
    name: "elpris.getPrices",
    arguments: args,
  });

  await client.close();

  const text = Array.isArray((res as any)?.content)
    ? (res as any).content[0]?.text
    : undefined;
  if (!text) throw new Error("Oväntat MCP-svar (saknar content[0].text)");
  return JSON.parse(text);
}

// liten sleep
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// generera med retries + fallbackmodell vid 429/503
async function generateWithRetry(
  modelName: string,
  args: Parameters<
    ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]
  >[0]
) {
  const backoff = [500, 1000, 2000, 4000]; // ms
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        tools,
        systemInstruction:
          "Du är en hjälpsam svensk assistent om elpriser. När du behöver exakta siffror " +
          "ska du kalla funktionen get_el_price. Redovisa i SEK/kWh och skriv datum/område.",
      });
      return await model.generateContent(args);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const retriable =
        msg.includes("503") ||
        msg.includes("429") ||
        msg.includes("overloaded");
      if (!retriable || attempt === backoff.length) throw e;
      await wait(backoff[attempt]);
    }
  }
  // osannolikt
  throw new Error("retry exhausted");
}

// ---- Definiera “verktyget” som Gemini får kalla ----
const tools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "get_el_price",
        description:
          "Hämta elpris för datum (YYYY-MM-DD) och område (SE1–SE4). Om datum saknas: använd dagens datum i Europe/Stockholm.",
        parameters: {
          type: "OBJECT",
          properties: {
            date: { type: "STRING", description: "YYYY-MM-DD" },
            area: { type: "STRING", enum: ["SE1", "SE2", "SE3", "SE4"] },
          },
          required: ["area"],
        },
      },
    ],
  },
];

// ---- Gemini-klient ----
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("Saknar GOOGLE_API_KEY i .env");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

// Hjälpare: plocka ut ev. function calls från svaret
function extractFunctionCalls(
  resp: any
): Array<{ id?: string; name: string; args: any }> {
  const calls: Array<{ id?: string; name: string; args: any }> = [];
  const cands = resp?.candidates ?? [];
  for (const cand of cands) {
    const parts = cand?.content?.parts ?? [];
    for (const p of parts) {
      if (p?.functionCall?.name) {
        calls.push({
          id: p.functionCall.id, // kan saknas i vissa svar → hanteras nedan
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
        });
      }
    }
  }
  return calls;
}

// Hjälpare: plocka textsvar (när modellen svarar efter tool-outputs)
function extractText(resp: any): string {
  const cands = resp?.candidates ?? [];
  for (const c of cands) {
    const parts = c?.content?.parts ?? [];
    const text = parts
      .map((p: any) => p?.text)
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return "(inget svar)";
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage: string = req.body?.message ?? "";

    // --- 1) första rundan ---
    let first = await generateWithRetry(PRIMARY_MODEL, {
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    }).catch(async () =>
      generateWithRetry(FALLBACK_MODEL, {
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
      })
    );

    const calls: Array<{ name: string; args: any }> = [];
    const cands = first.response?.candidates ?? [];
    for (const cand of cands) {
      const parts = cand?.content?.parts ?? [];
      for (const p of parts) {
        if (p?.functionCall?.name)
          calls.push({
            name: p.functionCall.name,
            args: p.functionCall.args ?? {},
          });
      }
    }

    if (calls.length > 0) {
      const toolParts = [];
      for (const c of calls) {
        if (c.name === "get_el_price") {
          const payload = await callMcpGetPrices(c.args);
          toolParts.push({
            functionResponse: { name: c.name, response: payload },
          });
        }
      }

      // --- 2) andra rundan ---
      const second = await generateWithRetry(PRIMARY_MODEL, {
        contents: [
          { role: "user", parts: [{ text: userMessage }] },
          {
            role: "model",
            parts: first.response.candidates?.[0]?.content?.parts ?? [],
          },
          { role: "tool", parts: toolParts },
        ],
      }).catch(async () =>
        generateWithRetry(FALLBACK_MODEL, {
          contents: [
            { role: "user", parts: [{ text: userMessage }] },
            {
              role: "model",
              parts: first.response.candidates?.[0]?.content?.parts ?? [],
            },
            { role: "tool", parts: toolParts },
          ],
        })
      );

      const text2 =
        (second.response?.candidates ?? [])
          .flatMap((cand: any) =>
            (cand?.content?.parts ?? [])
              .map((p: any) => p?.text)
              .filter(Boolean)
          )
          .join("\n") || "(inget svar)";
      return res.json({ reply: text2 });
    }

    const text1 =
      cands
        .flatMap((cand: any) =>
          (cand?.content?.parts ?? []).map((p: any) => p?.text).filter(Boolean)
        )
        .join("\n") || "(inget svar)";
    return res.json({ reply: text1 });
  } catch (err: any) {
    console.error(err);
    return res.status(503).json({ error: err?.message ?? String(err) });
  }
});

const PORT = 8787;
app.listen(PORT, () => {
  console.log(`Gemini chat-server igång på http://localhost:${PORT}/chat`);
});
