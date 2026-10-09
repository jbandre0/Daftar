// Verifies WCAG AA (4.5:1) for every text/background pair used in the tokens.
const L = (h) => { const c = [1,3,5].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v<=.03928? v/12.92 : ((v+.055)/1.055)**2.4); return .2126*c[0]+.7152*c[1]+.0722*c[2] }
const cr = (a,b) => { const [x,y] = [L(a),L(b)].sort((p,q)=>q-p); return (x+.05)/(y+.05) }
const themes = {
  lamplight: { desk:'#17110C', raised:'#221912', page:'#E4D3B0', ink:'#2A1F16', inkSoft:'#6B5640', ash:'#DCCBB0', ashSoft:'#A38F74', flame:'#E2A24C', onFlame:'#2A1F16', olive:'#8A9663', seal:'#8C2F22', onSeal:'#E4D3B0' },
  daylight:  { desk:'#E9DFCB', raised:'#F1E8D6', page:'#FBF6EA', ink:'#2B241C', inkSoft:'#6E604E', ash:'#3B3127', ashSoft:'#6A5D4B', flame:'#8F5311', onFlame:'#FBF6EA', olive:'#56613A', seal:'#8C2F22', onSeal:'#FBF6EA' },
}
const pairs = [['ink','page'],['inkSoft','page'],['ash','desk'],['ashSoft','desk'],['ash','raised'],['ashSoft','raised'],['flame','desk'],['flame','raised'],['onFlame','flame'],['olive','desk'],['onSeal','seal']]
let bad = 0
for (const [name,t] of Object.entries(themes)) for (const [f,b] of pairs) {
  const r = cr(t[f],t[b]); const ok = r>=4.5; if(!ok) bad++
  console.log(`${ok?'PASS':'FAIL'} ${name.padEnd(9)} ${f.padEnd(8)} on ${b.padEnd(7)} ${r.toFixed(2)}`)
}
process.exit(bad?1:0)
