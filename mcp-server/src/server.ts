import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express"; // <-- typer
import { z } from "zod";
import { fetch } from "undici";

// ---------- Typer ----------
type Area = "SE1" | "SE2" | "SE3" | "SE4";

type ApiRow = {
  SEK_per_kWh: number;
  EUR_per_kWh: number;
  EXR: number;
  time_start: string; // ISO 8601
  time_end: string;
};

// ---------- Hjälpfunktioner ----------
function toYyyyMmDd(dateLike?: string): string {
  if (dateLike) return dateLike;
  const nowSthlm = new Date(
    new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })
  );
  const y = nowSthlm.getFullYear();
  const m = String(nowSthlm.getMonth() + 1).padStart(2, "0");
  const d = String(nowSthlm.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toApiUrl(date: string, area: Area): string {
  const [y, m, d] = date.split("-");
  return `https://www.elprisetjustnu.se/api/v1/prices/${y}/${m}-${d}_${area}.json`;
}

async function getPrices(date: string, area: Area): Promise<ApiRow[]> {
  const url = toApiUrl(date, area);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch misslyckades (${res.status}) för ${date} ${area}`);
  const data = (await res.json()) as ApiRow[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Tomt svar för ${date} ${area}`);
  }
  return data;
}

function summarize(rows: ApiRow[]) {
  const prices = rows.map((r) => r.SEK_per_kWh);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  const now = new Date();
  const current = rows.find((r) => {
    const start = new Date(r.time_start);
    const end = new Date(r.time_end);
    return now >= start && now < end;
  });

  return {
    min_SEK_per_kWh: min,
    max_SEK_per_kWh: max,
    avg_SEK_per_kWh: avg,
    currentPrice_SEK_per_kWh: current?.SEK_per_kWh ?? null,
    current_slot: current ? { start: current.time_start, end: current.time_end } : null,
    count: rows.length,
  };
}

// ---------- Bygg MCP-server ----------
function buildServer() {
  const server = new McpServer({ name: "el-pris", version: "0.1.0" });

  server.registerTool(
    "elpris.getPrices",
    {
      title: "Hämta elpriser",
      description:
        "Hämtar elpriser för ett valt datum (YYYY-MM-DD) och elområde (SE1–SE4). Om datum utelämnas används dagens datum i Europe/Stockholm.",
      // Viktigt: raw shape, inte z.object(...)
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        area: z.enum(["SE1", "SE2", "SE3", "SE4"]).default("SE3"),
      },
    },
    async ({ date, area }) => {
      const d = toYyyyMmDd(date);
      const a = (area ?? "SE3") as Area;
      const rows = await getPrices(d, a);
      const summary = summarize(rows);
      const payload = {
        date: d,
        area: a,
        source: toApiUrl(d, a),
        summary,
        first_3_rows: rows.slice(0, 3),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  return server;
}

// ---------- Starta STDIO för Inspector ----------
const stdioServer = buildServer();
const stdioTransport = new StdioServerTransport();
await stdioServer.connect(stdioTransport);

// ---------- Starta HTTP för webben ----------
const app = express();
app.use(express.json());

// --- CORS manuellt på ALLA svar (ekar tillbaka efterfrågade headers) ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header("Origin");
  const allow =
    origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173";

  if (allow && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // Vary på både Origin och Access-Control-Request-Headers
    res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  // Ekar tillbaka exakt vad browsern frågar efter (inkl. mcp-protocol-version)
  const requested = req.header("Access-Control-Request-Headers");
  const defaultAllowed =
    "content-type, mcp-session-id, mcp-protocol-version";
  res.setHeader(
    "Access-Control-Allow-Headers",
    requested ?? defaultAllowed
  );

  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// (frivillig) enkel logg
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      // krävs av typerna; undefined = stateless
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (error) {
    console.error("MCP /mcp error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`MCP HTTP aktiv: http://localhost:${PORT}/mcp`);
});
