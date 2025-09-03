import { useCallback, useMemo, useState } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Area = "SE1" | "SE2" | "SE3" | "SE4";

type Summary = {
  min_SEK_per_kWh: number;
  max_SEK_per_kWh: number;
  avg_SEK_per_kWh: number;
  currentPrice_SEK_per_kWh: number | null;
  current_slot: { start: string; end: string } | null;
  count: number;
};

type Payload = {
  date: string;
  area: Area;
  source: string;
  summary: Summary;
  first_3_rows: unknown[];
};

function todaySthlm(): string {
  // YYYY-MM-DD i Europe/Stockholm
  const now = new Date(
    new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })
  );
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function App() {
  const [date, setDate] = useState(todaySthlm());
  const [area, setArea] = useState<Area>("SE3");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);

  const endpoint = useMemo(() => new URL("http://localhost:3000/mcp"), []);

  const fetchPrices = useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const transport = new StreamableHTTPClientTransport(endpoint);
      const client = new Client({ name: "el-pris-browser", version: "0.1.0" });
      await client.connect(transport);

      const res = await client.callTool({
        name: "elpris.getPrices",
        arguments: { date, area },
      });

      // Svaret är ett MCP-resultat där nyttolasten ligger i content[0].text som JSON-sträng
      const text = Array.isArray((res as any)?.content)
        ? (res as any).content[0]?.text
        : undefined;
      if (!text) throw new Error("Oväntat MCP-svar: content saknas");

      const parsed = JSON.parse(text) as Payload;
      setData(parsed);

      await client.close();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [endpoint, date, area]);

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      }}
    >
      <h1 style={{ fontSize: 40, marginBottom: 16 }}>Elpris via MCP</h1>

      {/* Formulär */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fetchPrices();
        }}
        style={{
          display: "grid",
          gap: 12,
          alignItems: "end",
          gridTemplateColumns: "max-content max-content max-content",
          marginBottom: 24,
        }}
      >
        <label style={{ display: "grid", gap: 6 }}>
          <span>Datum</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ padding: 8, borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Elområde</span>
          <select
            value={area}
            onChange={(e) => setArea(e.target.value as Area)}
            style={{ padding: 8, borderRadius: 6 }}
          >
            <option value="SE1">SE1</option>
            <option value="SE2">SE2</option>
            <option value="SE3">SE3</option>
            <option value="SE4">SE4</option>
          </select>
        </label>

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #666",
            background: loading ? "#444" : "#222",
            color: "white",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Hämtar..." : "Hämta"}
        </button>
      </form>

      {/* Status / Fel */}
      {error && (
        <div
          style={{
            color: "#ffb4b4",
            background: "#3a1e1e",
            border: "1px solid #6c2f2f",
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          Fel: {error}
        </div>
      )}

      {/* Resultat */}
      {data && (
        <section style={{ display: "grid", gap: 14 }}>
          <div style={{ opacity: 0.8 }}>
            <div>
              <strong>Datum:</strong> {data.date} — <strong>Område:</strong>{" "}
              {data.area}
            </div>
            <div>
              <strong>Källa:</strong> <a href={data.source}>{data.source}</a>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(140px, 1fr))",
              gap: 10,
            }}
          >
            <Card title="Min (SEK/kWh)">
              {data.summary.min_SEK_per_kWh.toFixed(4)}
            </Card>
            <Card title="Max (SEK/kWh)">
              {data.summary.max_SEK_per_kWh.toFixed(4)}
            </Card>
            <Card title="Snitt (SEK/kWh)">
              {data.summary.avg_SEK_per_kWh.toFixed(4)}
            </Card>
            <Card title="Just nu (SEK/kWh)">
              {data.summary.currentPrice_SEK_per_kWh?.toFixed(4) ?? "—"}
            </Card>
          </div>

          {data.summary.current_slot && (
            <div style={{ opacity: 0.8 }}>
              Slot:{" "}
              {new Date(data.summary.current_slot.start).toLocaleTimeString(
                "sv-SE"
              )}
              –{" "}
              {new Date(data.summary.current_slot.end).toLocaleTimeString(
                "sv-SE"
              )}
            </div>
          )}

          <details>
            <summary>Rådata (första 3 raderna)</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(data.first_3_rows, null, 2)}
            </pre>
          </details>
        </section>
      )}

      {!data && !error && !loading && (
        <p style={{ opacity: 0.8 }}>Välj datum/område och klicka “Hämta”.</p>
      )}
    </main>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        border: "1px solid #555",
        background: "#1f1f1f",
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{children}</div>
    </div>
  );
}
