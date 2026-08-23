const { execSync, spawn } = require('child_process');

const server = spawn('node', [__dirname + '/server.js'], { stdio: 'inherit' });
server.on('error', e => console.error('Server error:', e.message));

setTimeout(() => {
  const cf = spawn('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 
    ['tunnel', '--url', 'http://localhost:3000', '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  
  cf.stderr.on('data', d => {
    const s = d.toString();
    process.stderr.write(s);
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      console.log('\n=== SERVER URL ===');
      console.log('WSS: wss://' + m[0].replace('https://', ''));
      console.log('HTTP: ' + m[0]);
      console.log('==================\n');
    }
  });
  cf.on('error', e => console.error('Tunnel error:', e.message));
}, 2000);
