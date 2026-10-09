import sharp from 'sharp'
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#17110C"/><defs><radialGradient id="g" cx="25%" cy="20%" r="70%"><stop offset="0" stop-color="#E2A24C" stop-opacity=".35"/><stop offset="1" stop-color="#E2A24C" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><g transform="translate(${pad} ${pad}) scale(${(512-2*pad)/512})"><rect x="130" y="82" width="252" height="348" rx="3" fill="#E4D3B0"/><path d="M175 170h162M175 225h162M175 280h162M175 335h100" stroke="#6B5640" stroke-width="14" stroke-linecap="round"/></g></svg>`
const out = 'public/icons/'
await sharp(Buffer.from(svg(0))).resize(192).png().toFile(out+'icon-192.png')
await sharp(Buffer.from(svg(0))).resize(512).png().toFile(out+'icon-512.png')
await sharp(Buffer.from(svg(64))).resize(512).png().toFile(out+'icon-maskable-512.png')
