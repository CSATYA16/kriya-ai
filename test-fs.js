const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function run() {
  const wsUrl = 'ws://localhost:50600';
  
  // 1. Start Server
  const server = spawn('node', ['server/server.js'], { env: { ...process.env, PORT: '50600' } });
  await new Promise(r => setTimeout(r, 1000));
  
  // 2. Start Agent
  const agent = spawn('node', ['server/mac-agent.js'], { env: { ...process.env, CARRYON_SERVER: wsUrl } });
  await new Promise(r => setTimeout(r, 1000));
  
  // 3. Fake Phone WebSocket
  const WebSocket = require('ws');
  const phone = new WebSocket(wsUrl);
  
  await new Promise(r => { phone.on('open', r); });
  phone.send(JSON.stringify({ type: 'REGISTER', role: 'PHONE' }));
  await new Promise(r => setTimeout(r, 500));
  
  console.log('Sending request...');
  phone.send(JSON.stringify({ type: 'WORKFLOW_REQUEST', text: 'Create a workspace called TestCarryOnWorkspace' }));
  
  phone.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('[Phone received]:', msg.type);
    
    if (msg.type === 'ACTION_READY') {
       phone.send(JSON.stringify({ type: 'APPROVE', requestId: msg.requestId }));
    } else if (msg.type === 'PROGRESS') {
       console.log('  Progress:', msg.step, msg.label);
    } else if (msg.type === 'RESULT') {
       console.log('Result!', msg.success);
       // Test FS
       const desktop = path.join(os.homedir(), 'Desktop');
       const wpath = path.join(desktop, 'TestCarryOnWorkspace');
       try {
         await fs.access(wpath);
         await fs.access(path.join(wpath, 'Research'));
         await fs.access(path.join(wpath, 'Assets'));
         await fs.access(path.join(wpath, 'Documentation'));
         await fs.access(path.join(wpath, 'Presentation'));
         await fs.access(path.join(wpath, 'Tasks'));
         console.log('✅ fs access successful!');
         await fs.rm(wpath, { recursive: true, force: true });
         console.log('✅ cleanup successful!');
         server.kill();
         agent.kill();
         process.exit(0);
       } catch (err) {
         console.error('❌ FS test failed', err);
         server.kill();
         agent.kill();
         process.exit(1);
       }
    }
  });
}

run().catch(console.error);
