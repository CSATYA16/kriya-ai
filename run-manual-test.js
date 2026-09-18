const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

async function test() {
  const wsUrl = 'ws://127.0.0.1:50701';
  console.log('Starting server...');
  const server = spawn('node', ['server/server.js'], { env: { ...process.env, PORT: '50701' } });
  
  await new Promise(r => setTimeout(r, 1500));
  
  console.log('Starting agent...');
  const agent = spawn('node', ['server/mac-agent.js'], { env: { ...process.env, CARRYON_SERVER: wsUrl } });
  
  await new Promise(r => setTimeout(r, 1500));
  
  const phone = new WebSocket(wsUrl);
  phone.on('open', () => {
    console.log('Phone connected!');
    phone.send(JSON.stringify({ type: 'REGISTER', role: 'PHONE' }));
    setTimeout(() => {
      phone.send(JSON.stringify({ type: 'WORKFLOW_REQUEST', text: 'Create a workspace for my Hackathon project on the Desktop.' }));
    }, 500);
  });
  
  phone.on('message', data => {
    const msg = JSON.parse(data.toString());
    console.log('Phone msg:', msg.type);
    if (msg.type === 'ACTION_READY') {
      console.log('Approving action...');
      phone.send(JSON.stringify({ type: 'APPROVE', requestId: msg.requestId }));
    }
    if (msg.type === 'PROGRESS') {
      console.log('Progress:', msg.step, msg.label);
    }
    if (msg.type === 'RESULT') {
      console.log('Result received!');
      console.log('Path:', msg.path);
      server.kill();
      agent.kill();
      process.exit(0);
    }
  });
}
test().catch(console.error);
