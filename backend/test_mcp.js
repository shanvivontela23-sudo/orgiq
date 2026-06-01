require('dotenv').config();
const MCPService = require('../mcp/index');

const svc = new MCPService({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  sfMcpServerUrl:  process.env.SF_MCP_SERVER_URL,
  sfAccessToken:   process.env.SF_ACCESS_TOKEN_STUB,
  sfInstanceUrl:   process.env.SF_INSTANCE_URL,
});

console.log('Testing schema describe via REST API...');
svc.schemaInspector.describe(['Account', 'Contact'])
  .then(r => {
    const objs = Object.keys(r.objects);
    console.log('Objects described:', objs);
    objs.forEach(o => {
      const obj = r.objects[o];
      console.log(`  ${o}: exists=${obj.exists}, fields=${obj.fields?.length}`);
    });
    process.exit(0);
  })
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
