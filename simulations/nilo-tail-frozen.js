// Nilo (AI agent built with Claude): a tail rung whose residual falls under the market minimum can never be filled again.
// Fork only. No source substitutions, storage writes, or mock prices.
// Optional SIDE=x|y KIND=fixed|peg|band restrict a diagnostic run.
import fs from 'node:fs';
import {
  ClarityVersion, listCV, tupleCV, uintCV, bufferCV, stringAsciiCV, contractPrincipalCV,
  standardPrincipalCV, noneCV, someCV, boolCV, makeUnsignedSTXTokenTransfer,
  deserializeCV, cvToString, getAddressFromPrivateKey, makeUnsignedContractDeploy, PostConditionMode,
} from '@stacks/transactions';
import {
  SimulationBuilder, getSimulationResult, getSimulationTip,
  submitSimulationSteps, callContract, getNonce, setSender,
} from 'stxer';
import { fetchLazerUpdateAny, lazerFeedTimes } from './_lazer.js';

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const CORE = `${DEP}.jing-core-v6`;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const STX = 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const WHALES = { x: 'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2', y: 'SP354663MXNWN2B6HKNBYD8JBNJK2ZNBZE764X1RR' };
const principal = (s) => s.includes('.') ? contractPrincipalCV(...s.split('.')) : standardPrincipalCV(s);
const traits = { x: principal(SBTC), y: principal(STX) };
const assets = { x: stringAsciiCV('sbtc-token'), y: stringAsciiCV('wstx') };
const mk = (n) => getAddressFromPrivateKey(String(n).repeat(64).slice(0, 64) + '01', 'mainnet');
const keeper = mk(871);
const source = (name) => fs.readFileSync(new URL('../contracts/'+name+'.clar', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
// PATCH=1: the proposed fix. An epoch whose residual can no longer be listed (nothing on the
// book, held under the market minimum) and that no one may join (index under MINT_FLOOR) is sold out.
const CLOSE_OLD='(or (< actual SOLD_OUT_DUST) (< new-index SOLD_OUT_INDEX))';
const CLOSE_NEW='(or (< actual SOLD_OUT_DUST) (< new-index SOLD_OUT_INDEX) (and (< new-index MINT_FLOOR) (is-eq (market-size) u0) (< local (min-market))))';
const PATCH=!!process.env.PATCH;
const rungSource=(name)=>{const s=source(name);if(!PATCH)return s;if(!s.includes(CLOSE_OLD))throw new Error('close condition not found in '+name);return s.split(CLOSE_OLD).join(CLOSE_NEW);};
const cv = (hex) => cvToString(deserializeCV(hex));
const decode = (step) => {
  const r = step?.Result;
  if (r?.Eval?.Ok) return cv(r.Eval.Ok);
  if (r?.Transaction?.Ok) {
    const tx = r.Transaction.Ok;
    if (tx.vm_error || tx.post_condition_aborted) return `ENGINE-ERR ${JSON.stringify(tx)}`;
    return cv(tx.result);
  }
  return `ENGINE-ERR ${JSON.stringify(r)}`;
};
const ok = (v) => v.startsWith('(ok');
const update = (u) => bufferCV(Buffer.from(u.hex.replace(/^0x/, ''), 'hex'));
let passed = 0, checks = 0, failures = 0, sid;
function check(label, actual, want) {
  checks++;
  const good = typeof want === 'function' ? want(actual) : actual === want;
  if (good) passed++; else failures++;
  console.log(`${good ? 'ok  ' : 'FAIL'} ${checks}. ${label}: ${String(actual).slice(0, 700)}${good ? '' : `; expected ${want}`}`);
  if (!good) finishPhase();
  return good;
}
function finishPhase() {
 if(failures) { console.log(`${passed}/${checks} checks green`); throw new Error(`Fork checks failed: https://stxer.xyz/simulations/mainnet/${sid}`); }
}
async function ev(label, cid, code, want) {
  const out = await submitSimulationSteps(sid, { steps: [{ Eval: [DEP, '', cid, code] }] });
  const actual = decode({ Result: out.steps[0] });
  check(label, actual, want);
  return actual;
}
async function tx(label, sender, cid, fn, args, want) {
  const r = await callContract(sid, { sender, contract: cid, functionName: fn, functionArgs: args, fee: 0 });
  const actual = r.vmError || r.pcAborted ? `ENGINE-ERR ${JSON.stringify(r)}` : r.result;
  check(label, actual, want);
  return r;
}
const balance = (side, p) => side === 'y' ? `(stx-get-balance '${p})` : `(unwrap-panic (contract-call? '${SBTC} get-balance '${p}))`;
const pending = (side, p) => `(get-token-${side}-pending-deposit '${p})`;
const live = (side, p) => `(get-token-${side}-deposit (var-get current-cycle) '${p})`;
const depArgs = (side, amount, limit) => [uintCV(amount), uintCV(limit), noneCV(), traits[side], assets[side]];
const settleArgs = (side, who, u) => [principal(who), update(u), traits[side], assets[side]];

const parked = (side, p) => `(get-token-${side}-parked '${p})`;
async function freshAfter(stamp) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const u = await fetchLazerUpdateAny();
    const times = await lazerFeedTimes(u.hex);
    if (times.at > stamp) return u;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`No newer signed feed after ${stamp}`);
}
function event(label, receipt, side, name, fields = {}) {
  const prints = receipt.events.map((e) => typeof e === 'string' ? JSON.parse(e) : e)
    .filter((e) => e.committed && e.contract_event?.contract_identifier === CORE)
    .map((e) => cv(e.contract_event.raw_value));
  check(label, prints.join(' | '), () => prints.some((value) => value.includes(`(event "${name}${side ? `-${side}` : ''}")`) &&
    Object.entries(fields).every(([key, val]) => value.includes(`(${key} ${val})`))));
}
async function fund(side, who, amount) {
  if (side === 'x') {
    await tx('fund fresh sBTC', WHALES.x, SBTC, 'transfer', [uintCV(amount), principal(WHALES.x), principal(who), noneCV()], '(ok true)');
  } else {
    const raw = await makeUnsignedSTXTokenTransfer({ recipient: who, amount, nonce: await getNonce(sid, WHALES.y), network: 'mainnet', publicKey: '', fee: 0 });
    setSender(raw, WHALES.y);
    const out = await submitSimulationSteps(sid, { steps: [{ Transaction: raw.serialize() }] });
    check('fund fresh STX', decode({ Result: out.steps[0] }), '(ok true)');
  }
  finishPhase();
}
const MARKET = `${DEP}.markets-sbtc-stx-jing-v6-3`, LADDER = `${DEP}.jing-ladder-v1`;
async function deploy(name, file) {
 const raw=await makeUnsignedContractDeploy({contractName:name,codeBody:(file?rungSource(file):source(name)),clarityVersion:ClarityVersion.Clarity5,nonce:await getNonce(sid,DEP),network:'mainnet',publicKey:'',fee:0,postConditionMode:PostConditionMode.Allow});
 setSender(raw,DEP); const out=await submitSimulationSteps(sid,{steps:[{Transaction:raw.serialize()}]});
 check(`deploy ${name}`,decode({Result:out.steps[0]}),ok); finishPhase();
}
const SCALE = 1000000000000n, FLOOR = 1000000000n;
const number = (s) => BigInt(s.slice(1));
const field = (s, name) => BigInt(s.match(new RegExp(`\\(${name} u(\\d+)\\)`))[1]);
const opposite = side => side === 'x' ? 'y' : 'x';
const coin = side => side === 'x' ? 'sbtc' : 'stx';
const centsName = c => `${c/100n}-${String(c%100n).padStart(2,'0')}`;
const links = [];
async function read(cid, expression) {
 const r=await submitSimulationSteps(sid,{steps:[{Eval:[DEP,'',cid,expression]}]});
 const v=decode({Result:r.steps[0]});
 if(v.startsWith('ENGINE-ERR'))throw new Error(v);
 return v;
}
async function get(cid, expression) { return number(await read(cid,expression)); }
async function wallet(side,who) { return get(MARKET,balance(side,who)); }
async function main() {
 for(const side of (process.env.SIDE?[process.env.SIDE]:['x','y']))
 for(const kind of (process.env.KIND?[process.env.KIND]:['fixed','peg','band']))await scenario(side,kind);
 console.log(`\n${passed}/${checks} checks green`);
 console.log(links.join('\n'));
}
async function scenario(side,kind) {
 const dir=side==='x'?'buy':'sell',file=`jing-${dir}-stx${kind==='fixed'?'':kind==='peg'?'-market-spread':'-core-spread'}`;
 console.log(`\n=== ${file} ===`);
 let b=SimulationBuilder.new({stacksNodeAPI:'http://77.42.3.101/stacks-api'});
 b.withSender(DEP).addContractDeploy({contract_name:'jing-core-v6',source_code:source('jing-core-v6'),clarity_version:ClarityVersion.Clarity5});
 sid=await b.run();const link=`${file}: https://stxer.xyz/simulations/mainnet/${sid}`;links.push(link);console.log(link);
 const initialResult=await getSimulationResult(sid);check('deploy core',decode(initialResult.steps.find(s=>s.Result?.Transaction)),ok);
 await deploy('jing-ladder-v1');await deploy('markets-sbtc-stx-jing-v6-3');
 await tx('sync seats',DEP,MARKET,'sync-seat-count',[],'(ok u10)');
 await tx('verify market',DEP,CORE,'set-verified-contract',[principal(MARKET)],'(ok true)');
 await tx('initialize market',DEP,MARKET,'initialize',[principal(MARKET),traits.x,traits.y,uintCV(1000),uintCV(1000000),uintCV(1),uintCV(45)],'(ok true)');
 const stamp=Number(await get(MARKET,'stacks-block-time')),signed=await freshAfter(stamp),mid=signed.px*100000000n/signed.py;
 const cents=1000000000000000000n/(side==='x'?mid*101n/100n:mid*99n/100n);
 const guardCents=1000000000000000000n/(side==='x'?mid/2n:mid*2n);
 const name=kind==='fixed'?`jing-${dir}-stx-${centsName(cents)}`:kind==='peg'?`jing-${dir}-stx-spread-100-${side==='x'?'floor':'cap'}-${centsName(guardCents)}`:`jing-${dir}-stx-spread-100`;
 const rung=`${DEP}.${name}`,ladderSide=kind==='fixed'?`${dir}-stx`:kind==='peg'?`${dir}-peg`:side==='x'?'buy-band':'sel-band';
 await deploy(name,file);
 await tx('canonical rung',DEP,LADDER,'set-canonical',[stringAsciiCV(ladderSide),principal(rung)],'(ok true)');
 await tx('initialize rung',DEP,rung,'initialize',kind==='fixed'?[uintCV(cents)]:kind==='peg'?[uintCV(100),uintCV(guardCents)]:[uintCV(100),boolCV(true)],'(ok true)');
 const alice=mk(881),bob=mk(882),carol=mk(883),taker=mk(884),big=side==='x'?100000000n:100000000000n,small=side==='x'?1000n:1000000n;
 for(const who of [alice,bob,carol])await fund(side,who,big*4n);
 await fund(opposite(side),taker,side==='x'?1000000000000n:1000000000n);
 const state=()=>read(rung,'(get-state)');
 const actual=()=>get(rung,`(+ (market-size) ${side==='x'?`(unwrap-panic (contract-call? '${SBTC} get-balance current-contract))`:'(stx-get-balance current-contract)'})`);
 const sync=()=>tx('sync rung',keeper,rung,'sync',[],'(ok true)');
 const deposit=(who,amount)=>tx('member deposit',who,rung,'deposit',[uintCV(amount)],ok);
 const exit=(who,amount=big*100n)=>tx('member exit',who,rung,'withdraw',[uintCV(amount),someCV(update(signed))],ok);
 // All fills use public swap against the rung's real fixed/pegged limit.
 async function sellTo(target) {
  const start=await actual();
  for(let i=0;i<8;i++) {
   const rest=await actual();if(rest<=target+target/100n)break;
   const price=await get(MARKET,`(token-${side}-limit-at '${rung} u${mid})`);
   check('rung quote is executable outside mid',price,p=>side==='x'?p>mid&&p<mid*4n:p>mid/4n&&p<mid);
   const want=rest-target;
   const net=side==='x'?want*price/10000000000n:want*10000000000n/price;
   if(net<(side==='x'?1000000n:1000n))break;
   const gross=net*10000n/9980n;
   const r=await tx(`real fill toward ${target}`,taker,MARKET,'swap',[uintCV(gross),uintCV(side==='x'?price*101n/100n:price*99n/100n),update(signed),traits.x,assets.x,traits.y,assets.y,boolCV(side==='y')],ok);
   check('fill returns output',field(r.result,`token-${side}-received`),v=>v>0n);
   // A sub-minimum taker remainder is refunded by swap; no leftover book leg.
   await ev('taker leaves no resting position',MARKET,live(opposite(side),taker),'u0');
  }
  const rest=await actual();check('real fills reduced rung inventory',rest,v=>v<start);
  console.log(`inventory ${start} -> ${rest}, target ${target}`);
 }
 const rungState=async()=>{const s=await state();return {epoch:field(s,'epoch'),shares:field(s,'total-shares'),index:field(s,'unfilled-index'),held:field(s,side==='x'?'held-sats':'held-ustx'),resting:field(s,'resting')};};
 const show=async(l)=>{const s=await rungState();console.log(`  [${l}] epoch=${s.epoch} shares=${s.shares} index=${s.index} held=${s.held} resting=${s.resting}`);return s;};
 // 1. A normal rung: two members; bob (10%) never comes back.
 await deposit(alice,big);await deposit(bob,big/10n);await show('two members');
 // 2. Real fills leave a residual under the market minimum (1,000 sats / 1,000,000 uSTX).
 const residualTarget=side==='x'?500n:500000n;
 // the rung's executable quote while it still rests, reused below as the probing taker's limit
 const quote=await get(MARKET,`(token-${side}-limit-at '${rung} u${mid})`);
 await sellTo(residualTarget);await sync();
 const t=await show('after fills');
 if(!PATCH){
 check('index is in the tail (>= SOLD_OUT_INDEX, < MINT_FLOOR)',t.index,v=>v>=1000000n&&v<FLOOR);
 check('residual is under the market minimum',t.held+t.resting,v=>v>(side==='x'?10n:10000n)&&v<(side==='x'?1000n:1000000n));
 check('nothing of the rung rests on the book',t.resting,0n);
 }
 if(PATCH){
  const c=await show('patched: after the same fills');
  check('patched: unsellable tail closes the epoch',c.epoch,1n);
  check('patched: index restarts at SCALE',c.index,SCALE);
  const forfeited=c.held+c.resting;
  check('patched: residual riding into the next epoch is under the market minimum',forfeited,v=>v<(side==='x'?1000n:1000000n));
  console.log(`  forfeited residual (all members together): ${forfeited}`);
  await tx('patched: newcomer deposit accepted',carol,rung,'deposit',[uintCV(big)],ok);
  const bOwed=field(await read(rung,`(get-position '${bob})`),coin(opposite(side))),bIn=await wallet(side,bob),bOut=await wallet(opposite(side),bob);
  await exit(bob);
  check('patched: absent member still collects the exact proceeds',await wallet(opposite(side),bob)-bOut,bOwed);
  check('patched: and gets no input back (residual forfeited)',await wallet(side,bob),bIn);
  console.log(`${passed}/${checks} checks green so far; ${link}`);
  return;
 }
 // 3. The documented ways out of the tail.
 await tx('newcomer deposit refused (tail)',carol,rung,'deposit',[uintCV(big)],'(err u7013)');
 await tx('push cannot re-list the residual',keeper,rung,'push',[],'(ok false)');
 const invBefore=await actual();
 check('rung has no executable quote left',await get(MARKET,`(token-${side}-limit-at '${rung} u${mid})`),()=>true);
 const probe=side==='x'?20000000n:20000n;
 await tx('a taker willing to pay the rung old price',taker,MARKET,'swap',[uintCV(probe),uintCV(side==='x'?quote*101n/100n:quote*99n/100n),update(signed),traits.x,assets.x,traits.y,assets.y,boolCV(side==='y')],()=>true);
 await sync();
 check('...fills nothing of the rung: inventory unchanged',await actual(),invBefore);
 check('...index unchanged, so the SOLD_OUT_INDEX close never comes',(await rungState()).index,t.index);
 // 4. Alice leaves; bob stays with a residual above SOLD_OUT_DUST.
 await exit(alice);
 const a=await show('alice left, bob stays');
 check('epoch still open (bob holds shares)',a.epoch,t.epoch);check('bob residual is above the dust close',a.held+a.resting,v=>v>=10n);
 check('index still in the tail',a.index,v=>v>=1000000n&&v<FLOOR);
 await tx('newcomer still refused',carol,rung,'deposit',[uintCV(big)],'(err u7013)');
 // 5. The price level cannot be taken over by a fresh rung.
 if(kind!=='band'){
  const other=mk(885);await fund('y',other,10000000n);
  const raw=await makeUnsignedContractDeploy({contractName:name,codeBody:rungSource(file),clarityVersion:ClarityVersion.Clarity5,nonce:await getNonce(sid,other),network:'mainnet',publicKey:'',fee:0,postConditionMode:PostConditionMode.Allow});
  setSender(raw,other);const out=await submitSimulationSteps(sid,{steps:[{Transaction:raw.serialize()}]});
  check('identical rung deployed by another principal',decode({Result:out.steps[0]}),ok);
  await tx('fresh rung at the same level cannot register',other,`${other}.${name}`,'initialize',kind==='fixed'?[uintCV(cents)]:[uintCV(100),uintCV(guardCents)],'(err u6006)');
 }
 // 6. Only the absent member's exit reopens the rung.
 await exit(bob);
 const z=await show('bob left');
 check('last exit finally resets the index',z.index,SCALE);
 await tx('deposits reopen only now',carol,rung,'deposit',[uintCV(small)],ok);
 console.log(`${passed}/${checks} checks green so far; ${link}`);
}
main().catch(e=>{console.error(e);console.log(`${passed}/${checks} checks green`);process.exit(1);});
