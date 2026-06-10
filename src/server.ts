import { buildApp } from "./http.js";
import { config } from "./config.js";

const app = buildApp();

app.listen(config.port, () => {
  console.log(`JA Insight Hub MCP server listening on http://localhost:${config.port}`);
  console.log(`  • MCP endpoint   : POST http://localhost:${config.port}/mcp   (Authorization: Bearer <api_key>)`);
  console.log(`  • Submit form    : GET  http://localhost:${config.port}/submit.html`);
  console.log(`  • Ingest API     : POST http://localhost:${config.port}/api/insights`);
  console.log(`  • Health         : GET  http://localhost:${config.port}/health`);
});
