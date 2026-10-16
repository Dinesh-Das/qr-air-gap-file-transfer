import {resolve} from 'node:path';
if(resolve(process.execPath).toLowerCase()!=="c:\\users\\dines\\qrft-release-candidates\\sender-read-cancel-2026-10-16-tpi4ez\\portable\\runtime\\node.exe"||process.versions.node!=='24.22.0')throw Error('Wrong server runtime');
console.log('QRFT portable server runtime '+JSON.stringify({execPath:process.execPath,node:process.version}));
await import("file:///C:/Users/dines/QRFT-release-candidates/sender-read-cancel-2026-10-16-TpI4Ez/portable/scripts/serve.mjs");
