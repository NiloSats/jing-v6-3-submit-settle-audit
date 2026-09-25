// Nilo (AI agent built with Claude): fork test of afbf33d's lossless tail roll (bounty muerdzoc805a745ecc99).
// Same fills that froze the rung at 24f3e23; checks that a deposit now rolls the epoch and that the
// old members get proceeds + unsold share out of the reserve without the reserve going short.
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
const CONTRACTS = process.env.CONTRACTS || '../../jing-v3-afbf33d/contracts/';
const source = (name) => fs.readFileSync(new URL(CONTRACTS+name+'.clar', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
const rungSource=(name)=>source(name);
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
 // the pool's own inventory: the tail-roll reserve owed to closed epochs is excluded, as sync does
 const actual=()=>get(rung,`(- (+ (market-size) ${side==='x'?`(unwrap-panic (contract-call? '${SBTC} get-balance current-contract))`:'(stx-get-balance current-contract)'}) (var-get ${side==='x'?'reserved-sats':'reserved-ustx'}))`);
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

 // 2. Same real fills as the freeze repro: residual under the market minimum, index in the tail.
 const residualTarget=side==='x'?500n:500000n;
 await sellTo(residualTarget);await sync();
 const t=await show('after fills');
 check('index is in the tail (>= SOLD_OUT_INDEX, < MINT_FLOOR)',t.index,v=>v>=1000000n&&v<FLOOR);
 check('residual is under the market minimum',t.held+t.resting,v=>v>(side==='x'?10n:10000n)&&v<(side==='x'?1000n:1000000n));
 const RES=side==='x'?'reserved-sats':'reserved-ustx';
 const reserved=()=>get(rung,`(var-get ${RES})`);
 check('reserve empty before the roll',await reserved(),0n);
 // what each old member is owed at this point (read before the roll)
 const posOf=async(who)=>{const p=await read(rung,`(get-position '${who})`);return {back:field(p,coin(side)),proceeds:field(p,coin(opposite(side)))};};
 const aOwed=await posOf(alice),bOwed=await posOf(bob);
 console.log(`  owed before roll: alice back=${aOwed.back} proceeds=${aOwed.proceeds}; bob back=${bOwed.back} proceeds=${bOwed.proceeds}`);
 // 3. A newcomer deposit now rolls the epoch instead of refusing with u7013.
 await tx('newcomer deposit accepted (tail roll)',carol,rung,'deposit',[uintCV(big)],ok);
 const r=await show('after roll');
 check('epoch advanced by one',r.epoch,t.epoch+1n);
 const res0=await reserved();
 console.log(`  reserve after roll: ${res0}`);
 check('reserve covers what old members are owed',res0,v=>v>=aOwed.back+bOwed.back);
 // 4. Old members leave: each gets exactly proceeds + unsold share.
 const exitOld=async()=>{
 for(const [nm,who,o] of [['bob',bob,bOwed],['alice',alice,aOwed]]){
  const inS=await wallet(side,who),inO=await wallet(opposite(side),who);
  await tx(`${nm} (old epoch) exits`,who,rung,'withdraw',[uintCV(big*100n),someCV(update(signed))],ok);
  check(`${nm} gets the unsold share back (${coin(side)})`,await wallet(side,who)-inS,o.back);
  check(`${nm} gets the exact proceeds (${coin(opposite(side))})`,await wallet(opposite(side),who)-inO,o.proceeds);
 }
 const left=await reserved();
 console.log(`  reserve left after both old members: ${left} (rounding dust, never paid out)`);
 check('reserve never goes short (no underflow on the last exit)',left,v=>v>=0n);
 if(process.env.ROLLS!=='2')check('reserve leftover is rounding dust (< number of old members)',left,v=>v<2n);
 };
 if(process.env.ROLLS!=='2')await exitOld();
 if(process.env.ROLLS!=='2'){
 // 5. The new epoch works normally: carol can leave with her deposit.
 const cIn=await wallet(side,carol);
 await exit(carol);
 check('newcomer exits with her deposit (no fills in the new epoch)',await wallet(side,carol)-cIn,v=>v>=big-2n&&v<=big);
 console.log(`${passed}/${checks} checks green so far; ${link}`);
 return;
 }
 // 5b. ROLLS=2: carol's epoch is filled into its own tail and a fourth member rolls it again,
 // while carol has NOT left. Two closed epochs now owe from the same reserve.
 const dave=mk(886);await fund(side,dave,big*4n);
 await sellTo(residualTarget);await sync();
 const t2=await show('epoch 1 after fills');
 check('epoch 1 is in its tail too',t2.index,v=>v>=1000000n&&v<FLOOR);
 const cOwed=await posOf(carol);
 console.log(`  carol owed before second roll: back=${cOwed.back} proceeds=${cOwed.proceeds}`);
 const resBefore=await reserved();
 await tx('fourth member deposit rolls epoch 1',dave,rung,'deposit',[uintCV(big)],ok);
 const r2=await show('after second roll');
 check('epoch advanced to 2',r2.epoch,t.epoch+2n);
 const res2=await reserved();
 console.log(`  reserve before/after second roll: ${resBefore} -> ${res2}`);
 check('second roll adds at least carol unsold share to the reserve',res2-resBefore,v=>v>=cOwed.back);
 check('reserve now holds both closed epochs (epoch 0 + epoch 1 owed)',res2,v=>v>=aOwed.back+bOwed.back+cOwed.back);
 await exitOld();
 const inS=await wallet(side,carol),inO=await wallet(opposite(side),carol);
 await tx('carol (epoch 1) exits after the second roll',carol,rung,'withdraw',[uintCV(big*100n),someCV(update(signed))],ok);
 check('carol gets her unsold share back',await wallet(side,carol)-inS,cOwed.back);
 check('carol gets her exact proceeds',await wallet(opposite(side),carol)-inO,cOwed.proceeds);
 const res3=await reserved();
 console.log(`  reserve left after both rolls settled: ${res3}`);
 check('reserve never short after two rolls, all three old members paid',res3,v=>v>=0n&&v<3n);
 const dIn=await wallet(side,dave);
 await exit(dave);
 check('fourth member exits with his deposit',await wallet(side,dave)-dIn,v=>v>=big-2n&&v<=big);
 console.log(`${passed}/${checks} checks green so far; ${link}`);
}
main().catch(e=>{console.error(e);console.log(`${passed}/${checks} checks green`);process.exit(1);});
