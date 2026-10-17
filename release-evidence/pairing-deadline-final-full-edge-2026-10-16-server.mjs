import {resolve} from 'node:path';
if(resolve(process.execPath).toLowerCase()!=="d:\\myprojects\\qr air-gap file transfer\\artifacts\\qrft-2026-10-16-pairing-deadline-final-portable\\runtime\\node.exe"||process.versions.node!=='24.22.0')throw Error('Wrong server runtime');
console.log('QRFT portable server runtime '+JSON.stringify({execPath:process.execPath,node:process.version}));
await import("file:///D:/MyProjects/QR%20Air-Gap%20File%20Transfer/artifacts/qrft-2026-10-16-pairing-deadline-final-portable/scripts/serve.mjs");
