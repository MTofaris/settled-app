// @ts-nocheck
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";

const DEBT_TYPES = ["Credit Card","Personal Loan","Car Loan","Family Loan","Student Loan","Mortgage","Overdraft","Buy Now Pay Later","Business Loan","Medical Debt","Other"];
const FREE_LIMIT = 2;
const TYPE_ORDER = ["Credit Card","Overdraft","Buy Now Pay Later","Personal Loan","Car Loan","Family Loan","Student Loan","Mortgage","Business Loan","Medical Debt","Other"];

function mapToDb(debt, userId) {
  return {
    id: debt.id, name: debt.name, type: debt.type,
    user_id: userId || undefined,
    balance: debt.balance, original_balance: debt.originalBalance,
    interest_rate: debt.interestRate, minimum_payment: debt.minimumPayment,
    use_auto_min: debt.useAutoMin, remaining_months: debt.remainingMonths || null,
    term_months: debt.termMonths || null, start_date: debt.startDate || null,
    payment_due_day: debt.paymentDueDay || null,
    payoff_goal_months: debt.payoffGoalMonths || null,
    rate_changes: debt.rateChanges || [], rate_history: debt.rateHistory || [],
    payments: debt.payments || [],
  };
}

function mapFromDb(row) {
  return {
    id: row.id, name: row.name, type: row.type,
    balance: Number(row.balance), originalBalance: Number(row.original_balance),
    interestRate: Number(row.interest_rate), minimumPayment: Number(row.minimum_payment),
    useAutoMin: row.use_auto_min, remainingMonths: row.remaining_months,
    termMonths: row.term_months, startDate: row.start_date,
    paymentDueDay: row.payment_due_day, payoffGoalMonths: row.payoff_goal_months,
    rateChanges: row.rate_changes || [], rateHistory: row.rate_history || [],
    payments: row.payments || [],
  };
}

function calcMinPayment(balance, apr, type, remainingMonths) {
  const b = Number(balance), rate = Number(apr) / 100 / 12;
  if (!b || b <= 0) return 0;
  if (["Credit Card","Overdraft","Buy Now Pay Later"].includes(type)) {
    if (!apr || Number(apr) === 0) return Math.min(b, b < 25 ? b : Math.max(25, b * 0.01));
    return Math.min(b, b < 25 ? b : Math.max(25, b * 0.02));
  }
  const n = Number(remainingMonths) > 0 ? Number(remainingMonths) : ({"Mortgage":300,"Car Loan":60}[type] || 60);
  if (!apr || Number(apr) === 0) return Math.min(b, b / n);
  return Math.min(b, (b * rate * Math.pow(1+rate,n)) / (Math.pow(1+rate,n)-1));
}

function monthsElapsed(startDate) {
  if (!startDate) return 0;
  const s = new Date(startDate), now = new Date();
  return Math.max(0, (now.getFullYear()-s.getFullYear())*12+(now.getMonth()-s.getMonth()));
}

function formatCurrency(val) {
  if (!val && val !== 0) return "—";
  return "£" + Number(val).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2});
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
}

function simulatePayoff(balance, currentApr, monthlyPayment, rateChanges=[]) {
  let b = Number(balance);
  const pmt = Number(monthlyPayment);
  if (b <= 0) return {months:0,interest:0};
  if (pmt <= 0) return {months:Infinity,interest:Infinity};
  const today = new Date();
  const pending = (rateChanges||[]).filter(rc=>!rc.applied&&rc.date).map(rc=>{
    const d = new Date(rc.date);
    return {offset:Math.max(0,(d.getFullYear()-today.getFullYear())*12+(d.getMonth()-today.getMonth())),rate:Number(rc.newRate)};
  }).sort((a,z)=>a.offset-z.offset);
  let apr = Number(currentApr), interestPaid = 0, month = 0;
  while (b > 0 && month < 1200) {
    for (const rc of pending) { if (rc.offset===month) apr=rc.rate; }
    const rate = apr/100/12, interest = b*rate;
    if (rate>0&&pmt<=interest) return {months:Infinity,interest:Infinity};
    interestPaid += interest;
    b -= Math.min(b, pmt-interest);
    month++;
  }
  return month>=1200 ? {months:Infinity,interest:Infinity} : {months:month,interest:interestPaid};
}

function dateInMonths(n) {
  if (!isFinite(n)) return null;
  const d = new Date(); d.setMonth(d.getMonth()+n);
  return d.toLocaleDateString("en-GB",{month:"long",year:"numeric"});
}

function monthsToWords(n) {
  if (!n || !isFinite(n)) return null;
  const years = Math.floor(n/12), months = n%12;
  if (years===0) return `${months} month${months!==1?"s":""}`;
  if (months===0) return `${years} year${years!==1?"s":""}`;
  return `${years} year${years!==1?"s":""}, ${months} month${months!==1?"s":""}`;
}

function nextDueDate(day) {
  const d = Number(day);
  if (!d||d<1||d>31) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const thisMonth = new Date(today.getFullYear(),today.getMonth(),d);
  const target = thisMonth<today ? new Date(today.getFullYear(),today.getMonth()+1,d) : thisMonth;
  return {daysUntil:Math.round((target-today)/86400000),label:target.toLocaleDateString("en-GB",{day:"numeric",month:"short"})};
}

function ordinal(n) {
  const s=["th","st","nd","rd"],v=n%100;
  return n+(s[(v-20)%10]||s[v]||s[0]);
}

function calcGoalPayment(balance, apr, targetMonths) {
  const b=Number(balance),n=Number(targetMonths);
  if (!b||!n) return null;
  const rate=Number(apr)/100/12;
  if (rate===0) return b/n;
  return (b*rate*Math.pow(1+rate,n))/(Math.pow(1+rate,n)-1);
}

function simulateBudgetPayoff(debts, strategy, monthlyExtra) {
  if (!debts||debts.length===0) return null;
  if (monthlyExtra<0) return {shortfall:true};
  const pool = debts.map(d=>({id:d.id,name:d.name,balance:Number(d.balance),rate:Number(d.interestRate)/100/12,minPayment:Number(d.minimumPayment),clearedAt:null}));
  let extra=monthlyExtra,month=0,totalInterest=0;
  const milestones=[],MAX=600;
  while (pool.some(d=>d.balance>0)&&month<MAX) {
    month++;
    const active=pool.filter(d=>d.balance>0);
    if (strategy==="avalanche") active.sort((a,b)=>b.rate-a.rate); else active.sort((a,b)=>a.balance-b.balance);
    for (const d of pool) {
      if (d.balance<=0) continue;
      const interest=d.balance*d.rate; totalInterest+=interest;
      d.balance=Math.max(0,d.balance+interest-d.minPayment);
    }
    let pot=extra;
    for (const p of active) {
      const d=pool.find(x=>x.id===p.id);
      if (!d||d.balance<=0||pot<=0) continue;
      const payment=Math.min(d.balance,pot); d.balance=Math.max(0,d.balance-payment); pot-=payment;
    }
    const cleared=[];
    for (const d of pool) { if (d.balance<0.01&&!d.clearedAt) { d.balance=0;d.clearedAt=month;extra+=d.minPayment;cleared.push(d); } }
    if (cleared.length>0) milestones.push({month,date:dateInMonths(month),cleared,newExtra:extra,remaining:pool.filter(d=>d.balance>0).length});
  }
  if (month>=MAX) return null;
  return {months:month,totalInterest,milestones};
}

function buildPaymentTimeline(debts) {
  if (!debts||debts.length===0) return [];
  const enriched=debts.map(d=>{
    const pmt=d.payoffGoalMonths?(calcGoalPayment(d.balance,d.interestRate,d.payoffGoalMonths)||Number(d.minimumPayment)):Number(d.minimumPayment);
    const {months}=simulatePayoff(d.balance,d.interestRate,pmt,d.rateChanges);
    return {...d,monthlyPayment:pmt,clearsAt:isFinite(months)?months:null};
  });
  const startTotal=enriched.reduce((s,d)=>s+d.monthlyPayment,0);
  const byMonth={};
  for (const d of enriched) { if (d.clearsAt===null) continue; if (!byMonth[d.clearsAt]) byMonth[d.clearsAt]=[]; byMonth[d.clearsAt].push(d); }
  const milestones=[{month:0,label:"Now",total:startTotal,cleared:[],activeCount:enriched.length}];
  let runningTotal=startTotal,activeCount=enriched.length;
  for (const month of Object.keys(byMonth).map(Number).sort((a,b)=>a-b)) {
    const cleared=byMonth[month];
    runningTotal-=cleared.reduce((s,d)=>s+d.monthlyPayment,0);
    activeCount-=cleared.length;
    milestones.push({month,label:dateInMonths(month),total:Math.max(0,runningTotal),cleared,activeCount});
  }
  return milestones;
}

function ProgressBar({percent,color}) {
  return (
    <div style={{background:"#1e1e2e",borderRadius:999,height:6,overflow:"hidden",width:"100%"}}>
      <div style={{width:`${Math.min(percent,100)}%`,height:"100%",background:color,borderRadius:999,transition:"width 0.6s cubic-bezier(.4,0,.2,1)"}} />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div style={{minHeight:"100vh",background:"#0d0d17",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <div style={{fontSize:32,color:"#6366f1",marginBottom:16}}>✦</div>
      <div style={{fontSize:22,fontWeight:700,color:"#fff",marginBottom:24}}>Settled</div>
      <div style={{width:32,height:32,border:"3px solid #6366f130",borderTop:"3px solid #6366f1",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} />
      <style>{`@keyframes spin{to{transform:rotate(360deg);}}`}</style>
    </div>
  );
}

function CelebrationOverlay({title,subtitle,emoji,onDone}) {
  useEffect(()=>{ const t=setTimeout(onDone,2800); return ()=>clearTimeout(t); },[]);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif"}} onClick={onDone}>
      <div style={{textAlign:"center",padding:32,animation:"celebIn 0.4s cubic-bezier(.34,1.56,.64,1)"}}>
        <div style={{fontSize:72,marginBottom:16,display:"block"}}>{emoji}</div>
        <div style={{fontSize:26,fontWeight:800,color:"#fff",letterSpacing:"-0.5px",marginBottom:8}}>{title}</div>
        {subtitle&&<div style={{fontSize:15,color:"#94a3b8"}}>{subtitle}</div>}
        <div style={{marginTop:20,fontSize:12,color:"#475569"}}>Tap anywhere to continue</div>
      </div>
      <style>{`@keyframes celebIn{from{opacity:0;transform:scale(0.8)}to{opacity:1;transform:scale(1)}}`}</style>
    </div>
  );
}


function LandingPage({onGetStarted}) {
  const S = {
    page: {minHeight:"100vh",background:"#0d0d17",color:"#e2e8f0",fontFamily:"'DM Sans',-apple-system,'Segoe UI',sans-serif"},
    nav: {display:"flex",alignItems:"center",justifyContent:"space-between",padding:"20px 24px",maxWidth:1100,margin:"0 auto"},
    logo: {display:"flex",alignItems:"center",gap:8},
    hero: {textAlign:"center",padding:"72px 24px 56px",maxWidth:800,margin:"0 auto"},
    badge: {display:"inline-flex",alignItems:"center",gap:6,background:"#6366f115",border:"1px solid #6366f130",borderRadius:999,padding:"6px 16px",fontSize:13,color:"#a78bfa",fontWeight:600,marginBottom:24},
    h1: {fontSize:"clamp(34px,6vw,58px)",fontWeight:800,color:"#fff",letterSpacing:"-2px",lineHeight:1.1,marginBottom:20},
    sub: {fontSize:18,color:"#64748b",lineHeight:1.6,marginBottom:36,maxWidth:520,margin:"0 auto 36px"},
    btnPrimary: {background:"#6366f1",color:"#fff",padding:"16px 32px",borderRadius:12,fontSize:16,fontWeight:700,border:"none",cursor:"pointer",boxShadow:"0 8px 32px #6366f140"},
    btnSecondary: {background:"#12122a",border:"1px solid #1e1e3a",color:"#e2e8f0",padding:"16px 32px",borderRadius:12,fontSize:16,fontWeight:600,cursor:"pointer"},
    previewWrap: {maxWidth:860,margin:"0 auto 80px",padding:"0 24px"},
    previewInner: {background:"linear-gradient(135deg,#12122a,#0d0d17)",border:"1px solid #1e1e3a",borderRadius:24,padding:28},
    featuresWrap: {maxWidth:1100,margin:"0 auto 80px",padding:"0 24px"},
    featuresGrid: {display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:20,marginTop:48},
    featureCard: {background:"#12122a",border:"1px solid #1e1e3a",borderRadius:20,padding:28},
    featureIcon: {width:48,height:48,borderRadius:14,background:"#6366f115",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:16},
    pricingWrap: {maxWidth:800,margin:"0 auto 80px",padding:"0 24px"},
    pricingGrid: {display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:16,marginTop:32},
    pricingCard: (featured) => ({background:featured?"linear-gradient(135deg,#6366f112,#12122a)":"#12122a",border:featured?"2px solid #6366f1":"1px solid #1e1e3a",borderRadius:20,padding:28,position:"relative"}),
    ctaBanner: {maxWidth:800,margin:"0 auto 60px",padding:"0 24px"},
    ctaInner: {background:"linear-gradient(135deg,#6366f120,#a78bfa12)",border:"1px solid #6366f140",borderRadius:24,padding:"48px 32px",textAlign:"center"},
    footer: {borderTop:"1px solid #1e1e3a",padding:"28px 24px",maxWidth:1100,margin:"0 auto"},
  };

  const features = [
    {icon:"🎯",title:"Your exact debt-free date",desc:"See precisely when you'll clear every debt — calculated in real time as you add debts and log payments."},
    {icon:"⚡",title:"Pay Faster slider",desc:"Move a slider to see how any extra amount per month changes your debt-free date. Watch years disappear."},
    {icon:"🔥",title:"Smart strategies",desc:"Avalanche or Snowball — choose the approach that matches your goals and see the impact instantly."},
    {icon:"💰",title:"Budget Accelerator",desc:"Enter your income and expenses to see exactly how your surplus clears debt, month by month."},
    {icon:"📅",title:"Auto payment tracking",desc:"Set your due date and Settled automatically applies your minimum payment when it arrives."},
    {icon:"☁️",title:"Syncs everywhere",desc:"Your data is securely stored in the cloud. Access from any phone, tablet, or computer."},
  ];

  return (
    <div style={S.page}>
      <nav style={S.nav}>
        <div style={S.logo}>
          <span style={{fontSize:22,color:"#6366f1"}}>✦</span>
          <span style={{fontSize:20,fontWeight:800,color:"#fff",letterSpacing:"-0.5px"}}>Settled</span>
        </div>
        <button style={{...S.btnPrimary,padding:"10px 20px",fontSize:14,boxShadow:"none"}} onClick={onGetStarted}>Get started free →</button>
      </nav>

      <section style={S.hero}>
        <div style={S.badge}>✦ Built for UK debt freedom</div>
        <h1 style={S.h1}>Know exactly when you'll be <span style={{background:"linear-gradient(135deg,#6366f1,#a78bfa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>debt free</span></h1>
        <p style={S.sub}>Track every debt, plan your payoff strategy, and watch your freedom date get closer every month. Takes 60 seconds to get started.</p>
        <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginBottom:16}}>
          <button style={S.btnPrimary} onClick={onGetStarted}>Start for free — no card needed</button>
        </div>
        <div style={{fontSize:13,color:"#334155"}}>Free plan available · No credit card required</div>
      </section>

      <div style={S.previewWrap}>
        <div style={S.previewInner}>
          <div style={{display:"flex",gap:6,marginBottom:20}}>
            {["#f43f5e","#fbbf24","#34d399"].map(c=><div key={c} style={{width:10,height:10,borderRadius:"50%",background:c}} />)}
          </div>
          <div style={{background:"linear-gradient(135deg,#34d39915,#6366f112)",border:"1px solid #34d39940",borderRadius:16,padding:"18px 20px",marginBottom:12}}>
            <div style={{fontSize:11,color:"#34d399",fontWeight:700,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:6}}>🎯 You could be debt-free in</div>
            <div style={{fontSize:28,fontWeight:800,color:"#fff",letterSpacing:"-1px"}}>2 years, 4 months</div>
            <div style={{fontSize:13,color:"#64748b",marginTop:4}}>by October 2028 · at minimum payments</div>
          </div>
          <div style={{background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:14,padding:16,marginBottom:12}}>
            <div style={{fontSize:11,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:6}}>Total Remaining</div>
            <div style={{fontSize:30,fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:8}}>£12,450.00</div>
            <div style={{background:"#1e1e2e",borderRadius:999,height:6,marginBottom:6}}>
              <div style={{width:"38%",height:"100%",borderRadius:999,background:"linear-gradient(90deg,#6366f1,#a78bfa)"}} />
            </div>
            <div style={{fontSize:12,color:"#475569"}}>£7,550 paid · 38% complete</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["Active Debts","4","#fff"],["Highest Rate","24.9%","#f97316"],["Min Monthly","£385","#fff"],["Paid So Far","£7,550","#34d399"]].map(([l,v,c])=>(
              <div key={l} style={{background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:12,padding:12}}>
                <div style={{fontSize:10,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:4}}>{l}</div>
                <div style={{fontSize:20,fontWeight:800,color:c}}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <section style={S.featuresWrap}>
        <div style={{textAlign:"center",marginBottom:0}}>
          <div style={{fontSize:12,color:"#6366f1",fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",marginBottom:12}}>Everything you need</div>
          <h2 style={{fontSize:"clamp(26px,4vw,38px)",fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:12}}>Your personal debt advisor</h2>
          <p style={{fontSize:16,color:"#64748b",maxWidth:480,margin:"0 auto"}}>Settled gives you the tools and insights to pay off debt faster and smarter.</p>
        </div>
        <div style={S.featuresGrid}>
          {features.map(f=>(
            <div key={f.title} style={S.featureCard}>
              <div style={S.featureIcon}>{f.icon}</div>
              <div style={{fontSize:17,fontWeight:700,color:"#fff",marginBottom:8}}>{f.title}</div>
              <div style={{fontSize:14,color:"#64748b",lineHeight:1.6}}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={S.pricingWrap}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{fontSize:12,color:"#6366f1",fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",marginBottom:12}}>Simple pricing</div>
          <h2 style={{fontSize:"clamp(26px,4vw,38px)",fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:12}}>Start free, upgrade when ready</h2>
          <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:12,padding:"14px 20px",display:"inline-block",fontSize:14,color:"#64748b"}}>
            <strong style={{color:"#e2e8f0"}}>Free plan</strong> — Track up to 2 debts · See your debt-free date · No card needed
          </div>
        </div>
        <div style={S.pricingGrid}>
          {[
            {plan:"Monthly",price:"£2.99",period:"/mo",desc:"Flexible. Cancel anytime.",featured:false,link:"https://buy.stripe.com/5kQ00jcfv39o84W1pn4ow01",label:"Get started monthly"},
            {plan:"Yearly",price:"£19.99",period:"/yr",desc:"Best value. Save £15.89/yr.",featured:true,badge:"BEST VALUE",link:"https://buy.stripe.com/6oUcN54N3fWa70S8RP4ow02",label:"Get yearly access"},
          ].map(p=>(
            <div key={p.plan} style={S.pricingCard(p.featured)}>
              {p.badge&&<div style={{position:"absolute",top:-12,left:"50%",transform:"translateX(-50%)",background:"#6366f1",color:"#fff",fontSize:11,fontWeight:700,padding:"4px 14px",borderRadius:999,whiteSpace:"nowrap"}}>{p.badge}</div>}
              <div style={{fontSize:12,color:p.featured?"#a78bfa":"#64748b",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:12}}>{p.plan}</div>
              <div style={{fontSize:36,fontWeight:800,color:"#fff",letterSpacing:"-1px"}}>{p.price}<span style={{fontSize:14,color:"#475569",fontWeight:400}}>{p.period}</span></div>
              <div style={{fontSize:13,color:"#475569",margin:"10px 0 20px"}}>{p.desc}</div>
              {["Unlimited debts","Pay Faster slider","Payoff goals","Strategy comparison","Budget Accelerator","Backup & export"].map(f=>(
                <div key={f} style={{fontSize:13,color:"#94a3b8",padding:"6px 0",borderBottom:"1px solid #1e1e3a",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{color:"#34d399",fontWeight:700}}>✓</span>{f}
                </div>
              ))}
              <button style={{...S.btnPrimary,width:"100%",marginTop:20,background:p.featured?"#6366f1":"#1e1e3a",boxShadow:"none",fontSize:14}} onClick={()=>window.location.href=p.link}>{p.label}</button>
            </div>
          ))}
        </div>
        <div style={{fontSize:12,color:"#334155",textAlign:"center",marginTop:20}}>🔒 Secure payment via Stripe · No hidden fees · Cancel anytime</div>
      </section>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:16,maxWidth:800,margin:"0 auto 60px",padding:"0 24px"}}>
        {[["🔒","256-bit encryption","Your data is encrypted and never shared"],["🇬🇧","UK GDPR compliant","Built for UK users with full data protection"],["☁️","Your data, always","We never sell your data. Export or delete anytime"],["📱","Works everywhere","Phone, tablet, desktop — syncs across all devices"]].map(([icon,title,desc])=>(
          <div key={title} style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:14,padding:20,textAlign:"center"}}>
            <div style={{fontSize:24,marginBottom:8}}>{icon}</div>
            <div style={{fontSize:13,fontWeight:700,color:"#fff",marginBottom:4}}>{title}</div>
            <div style={{fontSize:12,color:"#475569",lineHeight:1.5}}>{desc}</div>
          </div>
        ))}
      </div>

      <div style={S.ctaBanner}>
        <div style={S.ctaInner}>
          <h2 style={{fontSize:"clamp(22px,4vw,34px)",fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:12}}>Start your journey to debt freedom today</h2>
          <p style={{fontSize:16,color:"#64748b",marginBottom:28}}>Free to start. No credit card needed. See your debt-free date in 60 seconds.</p>
          <button style={S.btnPrimary} onClick={onGetStarted}>Get started free →</button>
        </div>
      </div>

      <div style={{borderTop:"1px solid #1e1e3a",padding:"28px 24px",maxWidth:1100,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{color:"#6366f1"}}>✦</span>
          <span style={{fontWeight:700,color:"#fff"}}>Settled</span>
        </div>
        <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
          {[["Privacy Policy","/privacy.html"],["Terms & Conditions","/terms.html"],["Contact","mailto:hello@settlednow.co.uk"]].map(([label,href])=>(
            <a key={label} href={href} style={{fontSize:13,color:"#475569",textDecoration:"none"}}>{label}</a>
          ))}
        </div>
        <div style={{fontSize:13,color:"#334155"}}>© 2026 Settled</div>
      </div>
    </div>
  );
}

function AuthScreen() {
  const [mode,setMode]=useState("signin");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  async function handleSubmit() {
    setError(""); setMessage("");
    if (!email) { setError("Please enter your email."); return; }
    if (mode!=="reset"&&!password) { setError("Please enter your password."); return; }
    if (mode==="signup"&&password!==confirmPassword) { setError("Passwords don't match."); return; }
    if (mode==="signup"&&password.length<6) { setError("Password must be at least 6 characters."); return; }
    setLoading(true);
    try {
      if (mode==="signin") { const {error}=await supabase.auth.signInWithPassword({email,password}); if (error) setError(error.message); }
      else if (mode==="signup") { const {error}=await supabase.auth.signUp({email,password}); if (error) setError(error.message); else setMessage("Account created! Check your email to confirm, then sign in."); }
      else { const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin}); if (error) setError(error.message); else setMessage("Reset link sent — check your inbox."); }
    } finally { setLoading(false); }
  }

  const iS={width:"100%",background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:10,padding:"12px 14px",color:"#e2e8f0",fontSize:15,marginBottom:14,boxSizing:"border-box",outline:"none"};
  const lS={fontSize:12,color:"#64748b",fontWeight:600,letterSpacing:"0.5px",marginBottom:6,display:"block"};

  return (
    <div style={{minHeight:"100vh",background:"#0d0d17",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px 20px",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{fontSize:30,color:"#6366f1",marginBottom:8}}>✦</div>
        <div style={{fontSize:26,fontWeight:800,color:"#fff",letterSpacing:"-0.5px"}}>Settled</div>
        <div style={{fontSize:13,color:"#475569",marginTop:4}}>Know your debt. Own your future.</div>
      </div>
      <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:20,padding:"28px 24px",width:"100%",maxWidth:380}}>
        {mode!=="reset"&&(
          <div style={{display:"flex",background:"#0d0d17",borderRadius:10,padding:3,marginBottom:24,border:"1px solid #1e1e3a"}}>
            {["signin","signup"].map(m=>(
              <button key={m} style={{flex:1,padding:"9px 6px",borderRadius:8,border:"none",cursor:"pointer",fontSize:13,fontWeight:600,background:mode===m?"#6366f1":"transparent",color:mode===m?"#fff":"#475569",transition:"all 0.2s"}} onClick={()=>{setMode(m);setError("");setMessage("");}}>
                {m==="signin"?"Sign in":"Create account"}
              </button>
            ))}
          </div>
        )}
        {mode==="reset"&&<div style={{fontSize:20,fontWeight:700,color:"#fff",marginBottom:20}}>Reset password</div>}
        {error&&<div style={{background:"#f43f5e15",border:"1px solid #f43f5e40",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#f43f5e",marginBottom:16}}>{error}</div>}
        {message&&<div style={{background:"#34d39915",border:"1px solid #34d39940",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#34d399",marginBottom:16}}>{message}</div>}
        <label style={lS}>Email address</label>
        <input style={iS} type="email" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} />
        {mode!=="reset"&&(<><label style={lS}>Password</label><input style={iS} type="password" placeholder={mode==="signup"?"At least 6 characters":"••••••••"} value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} /></>)}
        {mode==="signup"&&(<><label style={lS}>Confirm password</label><input style={iS} type="password" placeholder="••••••••" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} /></>)}
        <button style={{width:"100%",background:"#6366f1",color:"#fff",border:"none",borderRadius:12,padding:"14px",fontSize:15,fontWeight:700,cursor:loading?"not-allowed":"pointer",opacity:loading?0.7:1,marginTop:4}} onClick={handleSubmit} disabled={loading}>
          {loading?"Please wait…":mode==="signin"?"Sign in":mode==="signup"?"Create account":"Send reset link"}
        </button>
        {mode==="signin"&&<button style={{background:"none",border:"none",color:"#6366f1",fontSize:12,cursor:"pointer",padding:0,marginTop:16,display:"block",textAlign:"center",width:"100%"}} onClick={()=>{setMode("reset");setError("");setMessage("");}}>Forgot password?</button>}
        {mode==="reset"&&<button style={{background:"none",border:"none",color:"#6366f1",fontSize:12,cursor:"pointer",padding:0,marginTop:16,display:"block",textAlign:"center",width:"100%"}} onClick={()=>{setMode("signin");setError("");setMessage("");}}>← Back to sign in</button>}
        <div style={{marginTop:20,borderTop:"1px solid #1e1e3a",paddingTop:16,textAlign:"center"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:10}}>
            <span style={{fontSize:14}}>🔒</span>
            <span style={{fontSize:11,color:"#334155"}}>256-bit encryption · Your data is never sold</span>
          </div>
          <div style={{display:"flex",justifyContent:"center",gap:16}}>
            <a href="/privacy.html" target="_blank" style={{fontSize:11,color:"#475569",textDecoration:"none"}}>Privacy Policy</a>
            <a href="/terms.html" target="_blank" style={{fontSize:11,color:"#475569",textDecoration:"none"}}>Terms & Conditions</a>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareCardModal({debts, totalPaid, totalDebt, totalOriginal, onClose}) {
  const canvasRef = useRef(null);
  const progress = totalOriginal > 0 ? Math.round((totalPaid/totalOriginal)*100) : 0;

  function downloadCard() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = 600; canvas.height = 340;
    // Background
    ctx.fillStyle = "#0d0d17";
    ctx.fillRect(0,0,600,340);
    // Purple accent bar
    const grad = ctx.createLinearGradient(0,0,600,0);
    grad.addColorStop(0,"#6366f1"); grad.addColorStop(1,"#a78bfa");
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,600,6);
    // Logo
    ctx.fillStyle = "#6366f1";
    ctx.font = "bold 22px sans-serif";
    ctx.fillText("✦ Settled", 40, 55);
    // Main headline
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText(`I've paid off ${formatCurrency(totalPaid)}`, 40, 120);
    // Subtext
    ctx.fillStyle = "#94a3b8";
    ctx.font = "18px sans-serif";
    ctx.fillText(`${progress}% of my total debt cleared — and counting.`, 40, 155);
    // Progress bar bg
    ctx.fillStyle = "#1e1e2e";
    ctx.beginPath(); ctx.roundRect(40,185,520,14,7); ctx.fill();
    // Progress bar fill
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(40,185,Math.max(10,520*(progress/100)),14,7); ctx.fill();
    // Stats
    ctx.fillStyle = "#475569";
    ctx.font = "13px sans-serif";
    ctx.fillText(`${debts.length} debt${debts.length!==1?"s":""} tracked · ${formatCurrency(totalDebt)} remaining`, 40, 224);
    // Footer
    ctx.fillStyle = "#334155";
    ctx.font = "12px sans-serif";
    ctx.fillText("Track your debt freedom at settledapp.co.uk", 40, 310);

    const link = document.createElement("a");
    link.download = "settled-progress.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:"20px 20px 0 0",padding:24,width:"100%",maxWidth:480}}>
        <div style={{fontSize:18,fontWeight:700,color:"#fff",marginBottom:4}}>Share your progress 🎉</div>
        <div style={{fontSize:13,color:"#475569",marginBottom:20}}>Show the world you're winning with your debt.</div>
        <div style={{background:"linear-gradient(135deg,#0d0d17,#12122a)",border:"1px solid #1e1e3a",borderRadius:16,padding:24,marginBottom:16}}>
          <div style={{fontSize:13,color:"#6366f1",fontWeight:700,marginBottom:8}}>✦ Settled</div>
          <div style={{fontSize:22,fontWeight:800,color:"#fff",marginBottom:4}}>I've paid off {formatCurrency(totalPaid)}</div>
          <div style={{fontSize:13,color:"#94a3b8",marginBottom:14}}>{progress}% of my total debt cleared — and counting.</div>
          <div style={{background:"#1e1e2e",borderRadius:999,height:8,marginBottom:8}}>
            <div style={{width:`${Math.min(progress,100)}%`,height:"100%",background:"linear-gradient(90deg,#6366f1,#a78bfa)",borderRadius:999}} />
          </div>
          <div style={{fontSize:11,color:"#475569"}}>{debts.length} debt{debts.length!==1?"s":""} tracked · {formatCurrency(totalDebt)} remaining</div>
        </div>
        <canvas ref={canvasRef} style={{display:"none"}} />
        <button style={{width:"100%",background:"#6366f1",color:"#fff",border:"none",borderRadius:12,padding:"14px",fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:10}} onClick={downloadCard}>
          ⬇ Download image
        </button>
        <button style={{width:"100%",background:"transparent",color:"#475569",border:"none",cursor:"pointer",fontSize:14,padding:"10px"}} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}


const initialForm = {
  name:"",type:"Credit Card",
  balance:"",interestRate:"",
  startDate:"",totalTermMonths:"",
  showAdvanced:false,
  useAutoMin:true,customMinPayment:"",
  paymentDueDay:"",payoffGoalMonths:"",
  rateChanges:[],
};

function FreedomScreen({totalPaid, startDate, onDismiss}) {
  const canvasRef = useRef(null);
  const months = startDate ? Math.round((new Date()-new Date(startDate))/2628000000) : null;

  function downloadCert() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = 800; canvas.height = 500;
    const grad = ctx.createLinearGradient(0,0,800,500);
    grad.addColorStop(0,"#0d0d17"); grad.addColorStop(1,"#12122a");
    ctx.fillStyle = grad; ctx.fillRect(0,0,800,500);
    ctx.strokeStyle = "#6366f140"; ctx.lineWidth = 2;
    ctx.strokeRect(20,20,760,460);
    const gold = ctx.createLinearGradient(0,0,800,0);
    gold.addColorStop(0,"#fbbf24"); gold.addColorStop(0.5,"#f59e0b"); gold.addColorStop(1,"#fbbf24");
    ctx.fillStyle = gold; ctx.font = "bold 16px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("✦ SETTLED", 400, 70);
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 44px sans-serif";
    ctx.fillText("Certificate of Debt Freedom", 400, 140);
    ctx.fillStyle = "#94a3b8"; ctx.font = "18px sans-serif";
    ctx.fillText("This certifies that you have paid off", 400, 190);
    ctx.fillStyle = gold; ctx.font = "bold 56px sans-serif";
    ctx.fillText(formatCurrency(totalPaid), 400, 270);
    ctx.fillStyle = "#94a3b8"; ctx.font = "18px sans-serif";
    ctx.fillText("in total debt" + (months ? ` over ${months} months` : ""), 400, 310);
    ctx.fillStyle = "#475569"; ctx.font = "14px sans-serif";
    ctx.fillText(new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}), 400, 430);
    ctx.fillStyle = "#334155"; ctx.font = "12px sans-serif";
    ctx.fillText("settledapp.co.uk", 400, 460);
    const link = document.createElement("a");
    link.download = "settled-freedom-certificate.png";
    link.href = canvas.toDataURL("image/png"); link.click();
  }

  return (
    <div style={{position:"fixed",inset:0,background:"#0d0d17",zIndex:600,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif",padding:24,textAlign:"center"}}>
      <div style={{fontSize:72,marginBottom:16}}>🎉</div>
      <div style={{fontSize:32,fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:8}}>You're debt free!</div>
      <div style={{fontSize:16,color:"#94a3b8",marginBottom:8}}>You paid off a total of</div>
      <div style={{fontSize:44,fontWeight:800,color:"#fbbf24",letterSpacing:"-2px",marginBottom:4}}>{formatCurrency(totalPaid)}</div>
      {months&&<div style={{fontSize:14,color:"#64748b",marginBottom:32}}>over {months} months</div>}
      <canvas ref={canvasRef} style={{display:"none"}} />
      <button style={{background:"linear-gradient(135deg,#fbbf24,#f59e0b)",color:"#0d0d17",border:"none",borderRadius:14,padding:"16px 28px",fontSize:16,fontWeight:800,cursor:"pointer",marginBottom:12,width:"100%",maxWidth:320}} onClick={downloadCert}>
        ⬇ Download Certificate
      </button>
      <button style={{background:"#6366f1",color:"#fff",border:"none",borderRadius:14,padding:"14px 28px",fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:12,width:"100%",maxWidth:320}} onClick={()=>{
        if(navigator.share){navigator.share({title:"I'm debt free!",text:`I just paid off ${formatCurrency(totalPaid)} of debt using Settled!`,url:"https://settledapp.co.uk"});}
        else{navigator.clipboard.writeText(`I just paid off ${formatCurrency(totalPaid)} of debt using Settled! settledapp.co.uk`);}
      }}>Share your win 🎊</button>
      <button style={{background:"transparent",border:"none",color:"#475569",fontSize:14,cursor:"pointer",marginTop:8}} onClick={onDismiss}>Continue to dashboard</button>
    </div>
  );
}

function AccountModal({session, isPremium, onClose, onSignOut}) {
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");

  async function sendReset() {
    setSending(true);
    await supabase.auth.resetPasswordForEmail(session.user.email, {redirectTo: window.location.origin});
    setMsg("Password reset email sent — check your inbox."); setSending(false);
  }

  return (
    <div style={{position:"fixed",inset:0,background:"#0d0d17ee",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:"20px 20px 0 0",padding:24,width:"100%",maxWidth:480}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:700,color:"#fff"}}>Account</div>
          <button style={{background:"none",border:"none",color:"#475569",fontSize:20,cursor:"pointer"}} onClick={onClose}>✕</button>
        </div>
        <div style={{background:"#0d0d17",borderRadius:12,padding:16,marginBottom:16}}>
          <div style={{fontSize:11,color:"#475569",fontWeight:600,letterSpacing:"0.5px",marginBottom:4}}>SIGNED IN AS</div>
          <div style={{fontSize:15,color:"#e2e8f0",fontWeight:600}}>{session.user.email}</div>
        </div>
        <div style={{background:isPremium?"linear-gradient(135deg,#6366f115,#a78bfa12)":"#0d0d17",border:isPremium?"1px solid #6366f140":"1px solid #1e1e3a",borderRadius:12,padding:16,marginBottom:16}}>
          <div style={{fontSize:11,color:isPremium?"#6366f1":"#475569",fontWeight:600,letterSpacing:"0.5px",marginBottom:4}}>PLAN</div>
          <div style={{fontSize:15,color:"#e2e8f0",fontWeight:600}}>{isPremium?"✦ Full Access — Lifetime":"Free Plan"}</div>
          {!isPremium&&<div style={{fontSize:12,color:"#475569",marginTop:4}}>Upgrade to unlock Pay Faster, Goals, and more</div>}
        </div>
        {msg&&<div style={{background:"#34d39915",border:"1px solid #34d39940",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#34d399",marginBottom:16}}>{msg}</div>}
        <button style={{width:"100%",background:"#1e1e3a",border:"none",borderRadius:12,padding:"13px",fontSize:14,fontWeight:600,color:"#94a3b8",cursor:"pointer",marginBottom:10}} onClick={sendReset} disabled={sending}>
          {sending?"Sending…":"Change password"}
        </button>
        <button style={{width:"100%",background:"#f43f5e15",border:"1px solid #f43f5e30",borderRadius:12,padding:"13px",fontSize:14,fontWeight:600,color:"#f43f5e",cursor:"pointer"}} onClick={onSignOut}>
          Sign out
        </button>
        <div style={{marginTop:16,textAlign:"center"}}><span style={{fontSize:11,color:"#334155"}}>🔒 256-bit encryption · Your data is never sold</span></div>
      </div>
    </div>
  );
}

function SliderSection({debts, strategy, sortedDebts, totalMinPayment, debtFreeProjection, formatCurrency, S}) {
  const [extra, setExtra] = useState(0);
  const totalDebtAmount = debts.reduce((s,d)=>s+Number(d.balance),0);
  const max = Math.round(totalDebtAmount);

  const baseMonths = debtFreeProjection&&!debtFreeProjection.infinite ? debtFreeProjection.months : null;
  const baseInterest = debts.reduce((s,d)=>{ const {interest}=simulatePayoff(d.balance,d.interestRate,d.minimumPayment,d.rateChanges); return s+(isFinite(interest)?interest:0); },0);
  const boosted = extra > 0 ? simulateBudgetPayoff(debts, strategy, extra) : null;
  const boostedMonths = boosted&&!boosted.shortfall ? boosted.months : null;
  const monthsSaved = baseMonths&&boostedMonths ? baseMonths-boostedMonths : null;
  const interestSaved = boosted&&!boosted.shortfall ? baseInterest-boosted.totalInterest : null;
  const priorityName = sortedDebts[0]?.name;
  const priorityRate = sortedDebts[0]?.interestRate;

  return (
    <div>
      <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:16,padding:"18px 18px 20px",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <div style={{fontSize:13,color:"#64748b"}}>Extra per month</div>
          <div style={{fontSize:24,fontWeight:800,color:"#fff",letterSpacing:"-0.5px"}}>£{extra}<span style={{fontSize:13,color:"#475569",fontWeight:400}}>/mo</span></div>
        </div>
        <input type="range" min={0} max={max} step={10} value={extra} onChange={e=>setExtra(Number(e.target.value))} style={{width:"100%",accentColor:"#6366f1",cursor:"pointer"}} />
        <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
          <span style={{fontSize:11,color:"#334155"}}>£0</span>
          <span style={{fontSize:11,color:"#334155"}}>£{max.toLocaleString()}</span>
        </div>
        <div style={{display:"flex",gap:8,marginTop:12}}>
          {[25,50,100,200].map(v=>(
            <button key={v} style={{flex:1,padding:"6px 4px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,background:extra===v?"#6366f1":"#1e1e3a",color:extra===v?"#fff":"#64748b",transition:"all 0.2s"}} onClick={()=>setExtra(v)}>+£{v}</button>
          ))}
        </div>
      </div>

      {extra===0&&baseMonths&&(
        <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:16,padding:18,marginBottom:16}}>
          <div style={{fontSize:11,color:"#475569",fontWeight:600,letterSpacing:"0.5px",marginBottom:6}}>AT MINIMUM PAYMENTS</div>
          <div style={{fontSize:26,fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:4}}>{debtFreeProjection?.words} to debt-free</div>
          <div style={{fontSize:13,color:"#64748b"}}>Move the slider above to see how extra payments help</div>
        </div>
      )}

      {extra>0&&monthsSaved!==null&&monthsSaved>0&&(
        <div style={{background:"linear-gradient(135deg,#34d39915,#6366f112)",border:"1px solid #34d39940",borderRadius:16,padding:18,marginBottom:16}}>
          <div style={{fontSize:11,color:"#34d399",fontWeight:700,letterSpacing:"0.5px",marginBottom:6}}>⚡ WITH £{extra} EXTRA PER MONTH</div>
          <div style={{fontSize:26,fontWeight:800,color:"#fff",letterSpacing:"-1px",marginBottom:8}}>{monthsToWords(boostedMonths)} to debt-free</div>
          <div style={{display:"flex",gap:20}}>
            <div><div style={{fontSize:11,color:"#64748b"}}>Time saved</div><div style={{fontSize:18,fontWeight:700,color:"#34d399"}}>{monthsToWords(monthsSaved)}</div></div>
            {interestSaved>0&&<div><div style={{fontSize:11,color:"#64748b"}}>Interest saved</div><div style={{fontSize:18,fontWeight:700,color:"#34d399"}}>{formatCurrency(interestSaved)}</div></div>}
          </div>
        </div>
      )}

      {extra>0&&priorityName&&(
        <div style={{background:"#6366f115",border:"1px solid #6366f130",borderRadius:12,padding:"12px 14px",marginBottom:16}}>
          <div style={{fontSize:11,color:"#6366f1",fontWeight:700,marginBottom:4}}>WHERE YOUR EXTRA MONEY GOES</div>
          <div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.5}}>Your extra £{extra}/mo goes to <strong>{priorityName}</strong> first ({priorityRate}% APR — {strategy==="avalanche"?"highest rate":"smallest balance"}). Once cleared, that money automatically rolls into the next debt.</div>
        </div>
      )}

      {boosted&&!boosted.shortfall&&boosted.milestones?.length>0&&(()=>{
        const allMilestones=[{month:0,date:"Now",cleared:[],remaining:debts.length},...boosted.milestones];
        let clearedMinsTotal=0;
        const milestonesWithTotals=allMilestones.map((m,i)=>{
          if (i>0) clearedMinsTotal+=m.cleared.reduce((s,d)=>s+d.minPayment,0);
          return {...m,monthlyTotal:totalMinPayment-clearedMinsTotal+extra};
        });
        const startTotal=milestonesWithTotals[0].monthlyTotal;
        return (
          <div style={{marginTop:4}}>
            <div style={{fontSize:14,fontWeight:700,color:"#fff",marginBottom:4}}>Monthly Payment Timeline</div>
            <div style={{fontSize:12,color:"#475569",marginBottom:16}}>Watch your total monthly payment drop as each debt clears</div>
            {milestonesWithTotals.map((m,i,arr)=>{
              const isFirst=i===0,isLast=i===arr.length-1;
              const prev=i>0?arr[i-1]:null;
              const drop=prev?prev.monthlyTotal-m.monthlyTotal:0;
              const barWidth=startTotal>0?(m.monthlyTotal/startTotal)*100:0;
              return (
                <div key={i} style={{display:"flex",gap:12,marginBottom:isLast?0:4}}>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:20,flexShrink:0}}>
                    <div style={{width:10,height:10,borderRadius:"50%",flexShrink:0,marginTop:4,background:isLast&&m.remaining===0?"#34d399":isFirst?"#6366f1":"#a78bfa",boxShadow:isLast&&m.remaining===0?"0 0 8px #34d39966":"none"}} />
                    {!isLast&&<div style={{width:2,flex:1,background:"#1e1e3a",marginTop:3}} />}
                  </div>
                  <div style={{flex:1,paddingBottom:isLast?0:18}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                      <div>
                        <div style={{fontSize:13,fontWeight:700,color:isFirst?"#a78bfa":"#e2e8f0"}}>{isFirst?"Today":m.date}</div>
                        {m.cleared&&m.cleared.map(d=><div key={d.id} style={{fontSize:11,color:"#34d399",marginTop:2}}>✓ {d.name} cleared</div>)}
                        {isLast&&m.remaining===0&&<div style={{fontSize:11,color:"#34d399",marginTop:2}}>🎉 All debts cleared!</div>}
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:15,fontWeight:800,color:isLast&&m.remaining===0?"#34d399":"#fff"}}>{isLast&&m.remaining===0?"£0/mo":formatCurrency(m.monthlyTotal)+"/mo"}</div>
                        {drop>0&&<div style={{fontSize:10,color:"#34d399",fontWeight:600}}>↓ {formatCurrency(drop)} less/mo</div>}
                      </div>
                    </div>
                    {m.monthlyTotal>0&&<div style={{background:"#0d0d17",borderRadius:999,height:4,overflow:"hidden"}}><div style={{width:`${barWidth}%`,height:"100%",borderRadius:999,background:isFirst?"#6366f1":isLast&&m.remaining===0?"#34d399":"#a78bfa"}} /></div>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}


export default function DebtTracker() {
  const [session,setSession]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [dataLoading,setDataLoading]=useState(false);
  const [dbError,setDbError]=useState("");
  const [debts,setDebts]=useState([]);
  const [strategy,setStrategy]=useState("avalanche");
  const [isPremium,setIsPremium]=useState(false);
  const [budgetIncome,setBudgetIncome]=useState(0);
  const [budgetExpenses,setBudgetExpenses]=useState(0);
  const [showUpgrade,setShowUpgrade]=useState(false);
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState(initialForm);
  const [editingId,setEditingId]=useState(null);
  const [paymentModal,setPaymentModal]=useState(null);
  const [paymentAmount,setPaymentAmount]=useState("");
  const [activeTab,setActiveTab]=useState("overview");
  const [showRateChange,setShowRateChange]=useState(false);
  const [rateChangeForm,setRateChangeForm]=useState({date:"",newRate:"",label:""});
  const [showPayoffIssues,setShowPayoffIssues]=useState(false);
  const [saving,setSaving]=useState(false);
  const [debtSort,setDebtSort]=useState("type");
  const [dashboardPaymentDebt,setDashboardPaymentDebt]=useState(null);
  const [celebration,setCelebration]=useState(null);
  const [showShareCard,setShowShareCard]=useState(false);
  const [showBudgetInput,setShowBudgetInput]=useState(false);
  const [showAccount,setShowAccount]=useState(false);
  const [showLanding,setShowLanding]=useState(true);
  const [showFreedom,setShowFreedom]=useState(false);
  const [freedomDismissed,setFreedomDismissed]=useState(false);
  const [showArchived,setShowArchived]=useState(false);
  const [showTimeline,setShowTimeline]=useState(false);

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{setSession(session);setAuthLoading(false);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_,session)=>{
      setSession(session);
      if (!session){setDebts([]);setStrategy("avalanche");setIsPremium(false);setBudgetIncome(0);setBudgetExpenses(0);}
    });
    return ()=>subscription.unsubscribe();
  },[]);

  const loadData=useCallback(async()=>{
    if (!session) return;
    setDataLoading(true); setDbError("");
    try {
      const [debtsRes,settingsRes,profileRes]=await Promise.all([
        supabase.from("debts").select("*").order("created_at",{ascending:true}),
        supabase.from("user_settings").select("*").maybeSingle(),
        supabase.from("profiles").select("is_premium").maybeSingle(),
      ]);
      if (debtsRes.data) setDebts(debtsRes.data.map(mapFromDb));
      if (settingsRes.data){setStrategy(settingsRes.data.strategy||"avalanche");setBudgetIncome(settingsRes.data.budget_income||0);setBudgetExpenses(settingsRes.data.budget_expenses||0);}
      if (profileRes.data) setIsPremium(profileRes.data.is_premium||false);
    } catch { setDbError("Failed to load data."); }
    finally { setDataLoading(false); }
  },[session]);

  useEffect(()=>{ if (session) loadData(); },[session]);

  useEffect(()=>{
    if (!session||dataLoading) return;
    const t=setTimeout(async()=>{
      await supabase.from("user_settings").upsert({user_id:session.user.id,strategy,budget_income:budgetIncome,budget_expenses:budgetExpenses});
    },1000);
    return ()=>clearTimeout(t);
  },[strategy,budgetIncome,budgetExpenses,session,dataLoading]);

  useEffect(()=>{
    if (!session) return;
    async function applyDueRateChanges() {
      const today=new Date().toISOString().split("T")[0];
      const updated=[];
      setDebts(prev=>{
        const next=prev.map(debt=>{
          if (!debt.rateChanges||debt.rateChanges.length===0) return debt;
          const due=debt.rateChanges.filter(rc=>!rc.applied&&rc.date<=today);
          if (due.length===0) return debt;
          const latest=due.sort((a,b)=>b.date.localeCompare(a.date))[0];
          const newRate=Number(latest.newRate);
          const newMin=debt.useAutoMin!==false?calcMinPayment(debt.balance,newRate,debt.type,debt.remainingMonths):debt.minimumPayment;
          const newDebt={...debt,interestRate:newRate,minimumPayment:newMin,rateChanges:debt.rateChanges.map(rc=>rc.date===latest.date?{...rc,applied:true}:rc),rateHistory:[...(debt.rateHistory||[]),{date:today,rate:newRate}]};
          updated.push(newDebt); return newDebt;
        }); return next;
      });
      for (const debt of updated) await supabase.from("debts").update(mapToDb(debt,session?.user?.id)).eq("id",debt.id);
    }
    applyDueRateChanges();
    const iv=setInterval(applyDueRateChanges,60000);
    return ()=>clearInterval(iv);
  },[session]);

  // ── AUTO-APPLY DUE PAYMENTS ──
  useEffect(()=>{
    if (!session||dataLoading) return;
    async function autoApplyDuePayments() {
      const today=new Date();
      const todayDate=today.getDate();
      const currentYear=today.getFullYear();
      const currentMonth=today.getMonth();
      const toUpdate=[];
      setDebts(prev=>{
        const next=prev.map(debt=>{
          if (!debt.paymentDueDay||Number(debt.balance)<=0) return debt;
          const dueDay=Number(debt.paymentDueDay);
          if (todayDate<dueDay) return debt;
          // Don't apply if debt was created this month after the due date
          if (debt.startDate) {
            const start=new Date(debt.startDate);
            if (start.getFullYear()===currentYear&&start.getMonth()===currentMonth) return debt;
          }
          // Check if already auto-applied this month
          const alreadyApplied=(debt.payments||[]).some(p=>{
            if (!p.auto) return false;
            const d=new Date(p.date);
            return d.getFullYear()===currentYear&&d.getMonth()===currentMonth;
          });
          if (alreadyApplied) return debt;
          // Auto-apply minimum payment
          const paymentAmount=Number(debt.minimumPayment);
          if (paymentAmount<=0) return debt;
          const newBalance=Math.max(0,Number(debt.balance)-paymentAmount);
          const newRemaining=debt.remainingMonths?Math.max(1,debt.remainingMonths-1):null;
          const newMin=debt.useAutoMin!==false?calcMinPayment(newBalance,debt.interestRate,debt.type,newRemaining):debt.minimumPayment;
          const updated={...debt,balance:newBalance,minimumPayment:newMin,remainingMonths:newRemaining,payments:[...(debt.payments||[]),{date:new Date().toISOString(),amount:paymentAmount,auto:true}]};
          toUpdate.push(updated);
          return updated;
        });
        return next;
      });
      for (const debt of toUpdate) {
        await supabase.from("debts").update(mapToDb(debt,session?.user?.id)).eq("id",debt.id);
      }
      if (toUpdate.length>0) {
        setCelebration({emoji:"✅",title:`${toUpdate.length} minimum payment${toUpdate.length!==1?"s":""} applied`,subtitle:`Auto-applied for: ${toUpdate.map(d=>d.name).join(", ")}. Log extra payments manually.`});
      }
    }
    autoApplyDuePayments();
  },[session,dataLoading]);

  const isRevolving=t=>["Credit Card","Overdraft","Buy Now Pay Later"].includes(t);
  const autoMin=useMemo(()=>calcMinPayment(form.balance,form.interestRate,form.type,form.totalTermMonths||null),[form.balance,form.interestRate,form.type,form.totalTermMonths]);

  const activeDebts=useMemo(()=>debts.filter(d=>Number(d.balance)>0),[debts]);
  const completedDebts=useMemo(()=>debts.filter(d=>Number(d.balance)<=0),[debts]);
  const totalDebt=useMemo(()=>activeDebts.reduce((s,d)=>s+Number(d.balance),0),[activeDebts]);
  const totalOriginal=useMemo(()=>debts.reduce((s,d)=>s+Number(d.originalBalance||d.balance),0),[debts]);
  const totalPaid=totalOriginal-totalDebt;
  const overallProgress=totalOriginal>0?(totalPaid/totalOriginal)*100:0;
  const totalMinPayment=useMemo(()=>activeDebts.reduce((s,d)=>s+Number(d.minimumPayment||0),0),[activeDebts]);

  // Freedom check
  useEffect(()=>{
    if (debts.length>0&&activeDebts.length===0&&!freedomDismissed) setShowFreedom(true);
  },[activeDebts,debts,freedomDismissed]);

  const debtFreeProjection=useMemo(()=>{
    if (activeDebts.length===0) return null;
    let maxMonths=0; const problemDebts=[];
    for (const d of activeDebts) {
      const {months}=simulatePayoff(d.balance,d.interestRate,d.minimumPayment,d.rateChanges);
      if (!isFinite(months)) {
        const mi=Number(d.balance)*(Number(d.interestRate)/100/12),tm=d.remainingMonths||36,rate=Number(d.interestRate)/100/12;
        const rec=rate===0?Number(d.balance)/tm:(Number(d.balance)*rate*Math.pow(1+rate,tm))/(Math.pow(1+rate,tm)-1);
        problemDebts.push({...d,monthlyInterest:mi,recommended:rec,targetMonths:tm}); continue;
      }
      if (months>maxMonths) maxMonths=months;
    }
    if (problemDebts.length>0) return {infinite:true,problemDebts};
    return {months:maxMonths,date:dateInMonths(maxMonths),words:monthsToWords(maxMonths)};
  },[activeDebts]);

  const goalProjection=useMemo(()=>{
    if (activeDebts.length===0||!activeDebts.some(d=>d.payoffGoalMonths)) return null;
    let maxMonths=0,totalMonthly=0;
    for (const d of activeDebts) {
      const goalPmt=d.payoffGoalMonths?calcGoalPayment(d.balance,d.interestRate,d.payoffGoalMonths):Number(d.minimumPayment);
      totalMonthly+=goalPmt||Number(d.minimumPayment);
      const {months}=simulatePayoff(d.balance,d.interestRate,goalPmt||d.minimumPayment,d.rateChanges);
      if (!isFinite(months)) return null;
      if (months>maxMonths) maxMonths=months;
    }
    return {months:maxMonths,date:dateInMonths(maxMonths),totalMonthly};
  },[activeDebts]);

  const budgetDisposable=budgetIncome>0?budgetIncome-budgetExpenses:0;
  const budgetMonthlyExtra=budgetDisposable>0?Math.max(0,budgetDisposable-totalMinPayment):0;
  const budgetProjection=useMemo(()=>{
    if (!budgetIncome||budgetDisposable<=0) return null;
    if (budgetDisposable<totalMinPayment) return {shortfall:true,gap:totalMinPayment-budgetDisposable};
    return simulateBudgetPayoff(activeDebts,strategy,budgetMonthlyExtra);
  },[activeDebts,strategy,budgetIncome,budgetExpenses,budgetDisposable,budgetMonthlyExtra,totalMinPayment]);

  const sortedDebts=useMemo(()=>{
    const c=[...activeDebts];
    return strategy==="avalanche"?c.sort((a,b)=>Number(b.interestRate)-Number(a.interestRate)):c.sort((a,b)=>Number(a.balance)-Number(b.balance));
  },[activeDebts,strategy]);

  const sortedDebtsView=useMemo(()=>{
    const c=[...activeDebts];
    switch(debtSort) {
      case "type": return c.sort((a,b)=>TYPE_ORDER.indexOf(a.type)-TYPE_ORDER.indexOf(b.type)||Number(b.balance)-Number(a.balance));
      case "balance_desc": return c.sort((a,b)=>Number(b.balance)-Number(a.balance));
      case "balance_asc": return c.sort((a,b)=>Number(a.balance)-Number(b.balance));
      case "apr_desc": return c.sort((a,b)=>Number(b.interestRate)-Number(a.interestRate));
      case "apr_asc": return c.sort((a,b)=>Number(a.interestRate)-Number(b.interestRate));
      case "payment_desc": return c.sort((a,b)=>Number(b.minimumPayment)-Number(a.minimumPayment));
      case "payment_asc": return c.sort((a,b)=>Number(a.minimumPayment)-Number(b.minimumPayment));
      case "name": return c.sort((a,b)=>a.name.localeCompare(b.name));
      default: return c;
    }
  },[activeDebts,debtSort]);

  const upcomingPayments=useMemo(()=>activeDebts.filter(d=>d.paymentDueDay).map(d=>({...d,due:nextDueDate(d.paymentDueDay)})).filter(d=>d.due&&d.due.daysUntil<=7).sort((a,b)=>a.due.daysUntil-b.due.daysUntil),[activeDebts]);
  function upcomingRateChanges(){const today=new Date().toISOString().split("T")[0]; return activeDebts.flatMap(d=>(d.rateChanges||[]).filter(rc=>!rc.applied&&rc.date>today).map(rc=>({...rc,debtName:d.name}))).sort((a,b)=>a.date.localeCompare(b.date));}
  const priorityDebt=sortedDebts[0];
  const upcoming=upcomingRateChanges();
  function typeColor(type){return {"Credit Card":"#f97316","Personal Loan":"#6366f1","Car Loan":"#22d3ee","Family Loan":"#a78bfa","Student Loan":"#34d399","Mortgage":"#fbbf24","Overdraft":"#f43f5e","Buy Now Pay Later":"#e879f9","Business Loan":"#38bdf8","Medical Debt":"#fb7185","Other":"#94a3b8"}[type]||"#94a3b8";}
  function debtProgress(debt){
    if (debt.termMonths&&debt.remainingMonths) return Math.min(100,((debt.termMonths-debt.remainingMonths)/debt.termMonths)*100);
    const orig=Number(debt.originalBalance||debt.balance); return orig>0?Math.min(100,((orig-Number(debt.balance))/orig)*100):0;
  }
  function getNextStep(){
    if (activeDebts.length===0) return null;
    if (debtFreeProjection?.infinite) return {icon:"⚠️",text:`${debtFreeProjection.problemDebts[0].name} won't clear at current payments. Tap to fix it.`,action:()=>{setShowPayoffIssues(true);}};
    if (priorityDebt) return {icon:"⚡",text:`Focus extra payments on ${priorityDebt.name} (${priorityDebt.interestRate}% APR) — ${strategy==="avalanche"?"highest rate first":"smallest balance first"}.`,action:null};
    return null;
  }
  function fc(e){const {name,value,type:t,checked}=e.target;setForm(f=>({...f,[name]:t==="checkbox"?checked:value}));}

  async function handleAddOrEdit(){
    if (saving) return;
    if (!form.name) return;
    if (form.balance===""||form.balance===null||form.balance===undefined) return;
    if (form.interestRate===""||form.interestRate===null||form.interestRate===undefined) return;
    setSaving(true);
    try {
      const balance=Number(form.balance),interestRate=Number(form.interestRate);
      const termMonths=Number(form.totalTermMonths)||null;
      let startDate=form.startDate||null,remainingMonths=termMonths,originalBalance=balance;
      if (startDate&&termMonths){
        const elapsed=monthsElapsed(startDate);
        remainingMonths=Math.max(1,termMonths-elapsed);
        originalBalance=Math.max(balance,balance*1.05);
      }
      const minimumPayment=form.useAutoMin?calcMinPayment(balance,interestRate,form.type,remainingMonths):Number(form.customMinPayment);
      if (editingId){
        const existing=debts.find(d=>String(d.id)===String(editingId))||{};
        const updated={...existing,name:form.name,type:form.type,interestRate,balance,useAutoMin:form.useAutoMin,minimumPayment,remainingMonths,rateChanges:form.rateChanges||[],paymentDueDay:form.paymentDueDay?Number(form.paymentDueDay):null,payoffGoalMonths:form.payoffGoalMonths?Number(form.payoffGoalMonths):null};
        setDebts(prev=>prev.map(d=>String(d.id)===String(editingId)?updated:d));
        const {error}=await supabase.from("debts").update(mapToDb(updated,session?.user?.id)).eq("id",editingId);
        if (error) setDbError("Failed to save changes: "+error.message);
        setEditingId(null);
      } else {
        const newDebt={id:Date.now(),name:form.name,type:form.type,balance,originalBalance,interestRate,termMonths,remainingMonths,startDate:startDate||new Date().toISOString().split("T")[0],useAutoMin:form.useAutoMin,minimumPayment,paymentDueDay:form.paymentDueDay?Number(form.paymentDueDay):null,payoffGoalMonths:form.payoffGoalMonths?Number(form.payoffGoalMonths):null,rateChanges:form.rateChanges||[],rateHistory:[],payments:[]};
        setDebts(prev=>[...prev,newDebt]);
        const {error}=await supabase.from("debts").insert([mapToDb(newDebt,session?.user?.id)]);
        if (error){setDbError("Failed to add debt: "+error.message);setDebts(prev=>prev.filter(d=>d.id!==newDebt.id));}
      }
      setForm(initialForm);setShowForm(false);
    } catch(e) {
      setDbError("Something went wrong — please try again.");
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  function handleEdit(debt){
    setForm({...initialForm,name:debt.name,type:debt.type,startDate:debt.startDate||"",balance:debt.balance,interestRate:debt.interestRate,totalTermMonths:debt.remainingMonths||"",useAutoMin:debt.useAutoMin!==false,customMinPayment:debt.minimumPayment,paymentDueDay:debt.paymentDueDay||"",payoffGoalMonths:debt.payoffGoalMonths||"",rateChanges:debt.rateChanges||[]});
    setEditingId(debt.id);setShowForm(true);
  }

  async function handleDelete(id){
    setDebts(prev=>prev.filter(d=>d.id!==id));
    const {error}=await supabase.from("debts").delete().eq("id",id);
    if (error){setDbError("Failed to delete.");loadData();}
  }

  async function handlePayment(){
    const amt=Number(paymentAmount); if (!amt||amt<=0) return;
    const debt=debts.find(d=>d.id===paymentModal.id); if (!debt) return;
    const newBalance=Math.max(0,Number(debt.balance)-amt);
    const newRemaining=debt.remainingMonths?Math.max(1,debt.remainingMonths-1):null;
    const newMin=debt.useAutoMin!==false?calcMinPayment(newBalance,debt.interestRate,debt.type,newRemaining):debt.minimumPayment;
    const updated={...debt,balance:newBalance,minimumPayment:newMin,remainingMonths:newRemaining,payments:[...(debt.payments||[]),{date:new Date().toISOString(),amount:amt}]};
    setDebts(prev=>prev.map(d=>d.id===debt.id?updated:d));
    const {error}=await supabase.from("debts").update(mapToDb(updated,session?.user?.id)).eq("id",debt.id);
    if (error) setDbError("Failed to log payment.");
    setPaymentModal(null);setPaymentAmount("");
    if (newBalance===0){setCelebration({emoji:"🎉",title:`${debt.name} is paid off!`,subtitle:"Amazing — one less debt to worry about."});}
    else {setCelebration({emoji:"💪",title:"Payment logged!",subtitle:`${formatCurrency(newBalance)} remaining on ${debt.name}.`});}
  }

  function addRateChange(){if (!rateChangeForm.date||!rateChangeForm.newRate) return;setForm(f=>({...f,rateChanges:[...f.rateChanges,{...rateChangeForm,applied:false}]}));setRateChangeForm({date:"",newRate:"",label:""});setShowRateChange(false);}
  function removeRateChange(i){setForm(f=>({...f,rateChanges:f.rateChanges.filter((_,idx)=>idx!==i)}));}

  async function exportData(format){
    if (format==="json"){const blob=new Blob([JSON.stringify({debts,strategy,exportedAt:new Date().toISOString()},null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`settled-backup-${new Date().toISOString().split("T")[0]}.json`;a.click();URL.revokeObjectURL(url);}
    else{const rows=[["Name","Type","Balance","APR %","Min Payment"],...debts.map(d=>[d.name,d.type,d.balance,d.interestRate,d.minimumPayment])];const blob=new Blob([rows.map(r=>r.map(c=>`"${c}"`).join(",")).join("\n")],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`settled-${new Date().toISOString().split("T")[0]}.csv`;a.click();URL.revokeObjectURL(url);}
  }

  async function importData(e){
    const file=e.target.files[0]; if (!file) return;
    try{const text=await file.text();const data=JSON.parse(text);if (data.debts&&Array.isArray(data.debts)){for (const debt of data.debts) await supabase.from("debts").insert([mapToDb(debt,session?.user?.id)]);await loadData();}}
    catch{setDbError("Failed to restore backup.");}
  }

  async function handleSignOut(){await supabase.auth.signOut();}

  if (authLoading) return <LoadingScreen />;
  if (!session) {
    if (showLanding) return <LandingPage onGetStarted={()=>setShowLanding(false)} />;
    return <AuthScreen />;
  }
  if (dataLoading) return <LoadingScreen />;

  const nextStep=getNextStep();
  const selId=dashboardPaymentDebt||String(priorityDebt?.id||"");
  const displayDebt=activeDebts.find(d=>String(d.id)===selId)||priorityDebt;
  const firstDebtDate=debts.length>0?debts.reduce((earliest,d)=>(!earliest||d.startDate<earliest)?d.startDate:earliest,null):null;

  const S={
    app:{minHeight:"100vh",background:"#0d0d17",color:"#e2e8f0",fontFamily:"'DM Sans','Segoe UI',sans-serif",paddingBottom:90},
    header:{background:"linear-gradient(135deg,#12122a 0%,#0d0d17 100%)",borderBottom:"1px solid #1e1e3a",padding:"20px 20px 0"},
    tabs:{display:"flex",gap:4,marginTop:16},
    tab:a=>({padding:"8px 14px",borderRadius:"8px 8px 0 0",border:"none",cursor:"pointer",fontSize:12,fontWeight:600,background:a?"#1e1e3a":"transparent",color:a?"#fff":"#64748b",transition:"all 0.2s"}),
    section:{padding:"20px 20px 0"},
    card:{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:16,padding:20,marginBottom:16},
    row:{display:"flex",alignItems:"center",justifyContent:"space-between"},
    pill:c=>({background:c+"20",color:c,borderRadius:999,padding:"3px 10px",fontSize:11,fontWeight:600}),
    btn:v=>({padding:v==="sm"?"7px 14px":"12px 22px",borderRadius:10,border:"none",cursor:"pointer",fontWeight:600,fontSize:v==="sm"?12:14,background:v==="primary"?"#6366f1":v==="danger"?"#f43f5e22":v==="ghost"?"transparent":v==="outline"?"transparent":"#1e1e3a",color:v==="primary"?"#fff":v==="danger"?"#f43f5e":v==="ghost"?"#64748b":v==="outline"?"#6366f1":"#cbd5e1",border:v==="outline"?"1px solid #6366f1":"none",transition:"all 0.2s"}),
    fab:{position:"fixed",bottom:24,right:20,background:"#6366f1",color:"#fff",border:"none",borderRadius:999,padding:"14px 22px",fontSize:14,fontWeight:700,cursor:"pointer",boxShadow:"0 8px 32px #6366f166",zIndex:100,display:"flex",alignItems:"center",gap:8},
    modal:{position:"fixed",inset:0,background:"#0d0d17ee",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"},
    modalBox:{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:"20px 20px 0 0",padding:24,width:"100%",maxWidth:480,maxHeight:"92vh",overflowY:"auto"},
    label:{fontSize:12,color:"#64748b",fontWeight:600,letterSpacing:"0.5px",marginBottom:6,display:"block"},
    input:{width:"100%",background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:10,padding:"12px 14px",color:"#e2e8f0",fontSize:15,marginBottom:14,boxSizing:"border-box",outline:"none"},
    select:{width:"100%",background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:10,padding:"12px 14px",color:"#e2e8f0",fontSize:15,marginBottom:14,boxSizing:"border-box"},
    priorityBadge:{display:"inline-flex",alignItems:"center",gap:5,background:"#fbbf2420",color:"#fbbf24",borderRadius:999,padding:"4px 10px",fontSize:11,fontWeight:700,marginBottom:10},
    emptyState:{textAlign:"center",padding:"48px 20px",color:"#475569"},
    lockBanner:{background:"linear-gradient(135deg,#6366f115,#a78bfa12)",border:"1px solid #6366f140",borderRadius:16,padding:24,textAlign:"center",marginBottom:16},
  };

  return (
    <div style={S.app}>
      {showFreedom&&<FreedomScreen totalPaid={totalPaid} startDate={firstDebtDate} onDismiss={()=>{setShowFreedom(false);setFreedomDismissed(true);}} />}
      {celebration&&<CelebrationOverlay {...celebration} onDone={()=>setCelebration(null)} />}
      {showShareCard&&<ShareCardModal debts={debts} totalPaid={totalPaid} totalDebt={totalDebt} totalOriginal={totalOriginal} onClose={()=>setShowShareCard(false)} />}
      {showAccount&&<AccountModal session={session} isPremium={isPremium} onClose={()=>setShowAccount(false)} onSignOut={handleSignOut} />}

      <div style={S.header}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontSize:22,fontWeight:700,letterSpacing:"-0.5px",color:"#fff",display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:22,color:"#6366f1"}}>✦</span><span>Settled</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {totalPaid>0&&<button style={{background:"#6366f115",border:"1px solid #6366f130",borderRadius:8,color:"#6366f1",fontSize:11,fontWeight:600,cursor:"pointer",padding:"5px 10px"}} onClick={()=>setShowShareCard(true)}>Share 🎉</button>}
            <button style={{background:"#1e1e3a",border:"none",color:"#94a3b8",fontSize:20,cursor:"pointer",width:36,height:36,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowAccount(true)}>👤</button>
          </div>
        </div>
        {!isPremium&&(
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 14px",background:"#1e1e3a",borderRadius:10,margin:"12px 0 0"}}>
            <div style={{fontSize:12,color:"#64748b"}}>Free plan · <strong style={{color:activeDebts.length>=FREE_LIMIT?"#f97316":"#e2e8f0"}}>{activeDebts.length}/{FREE_LIMIT}</strong> debts used</div>
            <button style={{fontSize:11,fontWeight:700,color:"#6366f1",background:"transparent",border:"none",cursor:"pointer",padding:0}} onClick={()=>setShowUpgrade(true)}>Upgrade · from £2.99 →</button>
          </div>
        )}
        {isPremium&&<div style={{padding:"8px 0 0"}}><span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>✦ Full Access</span></div>}
        <div style={S.tabs}>
          {[["overview","Overview"],["debts","My Debts"],["summary","Pay Faster ✦"]].map(([id,label])=>(
            <button key={id} style={S.tab(activeTab===id)} onClick={()=>{
              if (id==="summary"&&!isPremium){setShowUpgrade(true);return;}
              setActiveTab(id);
            }}>{label}</button>
          ))}
        </div>
      </div>

      {dbError&&(
        <div style={{background:"#f43f5e15",border:"1px solid #f43f5e40",margin:"12px 20px 0",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#f43f5e",display:"flex",justifyContent:"space-between"}}>
          <span>⚠️ {dbError}</span>
          <button style={{background:"none",border:"none",color:"#f43f5e",cursor:"pointer"}} onClick={()=>setDbError("")}>✕</button>
        </div>
      )}

      {activeTab==="overview"&&(
        <div style={S.section}>
          {activeDebts.length===0&&completedDebts.length===0?(
            <div style={{paddingTop:24}}>
              <div style={{textAlign:"center",marginBottom:28}}>
                <div style={{fontSize:40,marginBottom:12}}>📊</div>
                <div style={{fontSize:22,fontWeight:800,color:"#fff",letterSpacing:"-0.5px",marginBottom:8}}>Your debt-free date<br/>starts here</div>
                <div style={{fontSize:14,color:"#475569",lineHeight:1.6,marginBottom:24}}>Add your first debt and instantly see when you'll be free, how much interest you'll save, and exactly what to pay each month.</div>
              </div>
              <div style={{background:"linear-gradient(135deg,#12122a,#1a1a35)",border:"1px solid #1e1e3a",borderRadius:16,padding:20,marginBottom:16,opacity:0.6}}>
                <div style={{fontSize:11,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:6}}>PREVIEW</div>
                <div style={{fontSize:36,fontWeight:800,color:"#fff",letterSpacing:"-2px",marginBottom:4}}>£8,450.00</div>
                <div style={{background:"#1e1e2e",borderRadius:999,height:6,marginBottom:6}}><div style={{width:"42%",height:"100%",background:"linear-gradient(90deg,#6366f1,#a78bfa)",borderRadius:999}} /></div>
                <div style={{fontSize:12,color:"#475569",marginBottom:16}}>£6,200 paid · 42% complete</div>
                <div style={{background:"linear-gradient(135deg,#34d39912,#a78bfa12)",border:"1px solid #34d39940",borderRadius:14,padding:14}}>
                  <div style={{fontSize:11,color:"#34d399",fontWeight:600,marginBottom:4}}>🎯 DEBT-FREE IN</div>
                  <div style={{fontSize:22,fontWeight:800,color:"#34d399"}}>2 years, 8 months</div>
                </div>
              </div>
              <div style={{textAlign:"center",background:"#6366f115",border:"1px solid #6366f130",borderRadius:14,padding:"16px 20px"}}>
                <div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:4}}>👇 Add your first debt below</div>
                <div style={{fontSize:13,color:"#64748b"}}>Takes less than 60 seconds</div>
              </div>
            </div>
          ):(
            <>
              {upcomingPayments.length>0&&(
                <div style={{background:"#6366f115",border:"1px solid #6366f140",borderRadius:12,padding:"12px 16px",marginBottom:16,marginTop:4}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#a78bfa",marginBottom:4}}>💳 Payments Due Soon</div>
                  {upcomingPayments.map((d,i)=>(
                    <div key={i} style={{fontSize:12,color:"#94a3b8",marginBottom:2,display:"flex",justifyContent:"space-between"}}>
                      <span><strong style={{color:"#e2e8f0"}}>{d.name}</strong> · due {d.due.label}</span>
                      <span style={{color:d.due.daysUntil===0?"#f43f5e":d.due.daysUntil<=3?"#f97316":"#a78bfa",fontWeight:600}}>{d.due.daysUntil===0?"Today!":d.due.daysUntil===1?"Tomorrow":`${d.due.daysUntil}d`}</span>
                    </div>
                  ))}
                </div>
              )}

              {debtFreeProjection&&!debtFreeProjection.infinite&&(
                <div style={{background:"linear-gradient(135deg,#34d39915,#6366f112)",border:"1px solid #34d39940",borderRadius:18,padding:"20px 20px 16px",marginBottom:16,marginTop:4}}>
                  <div style={{fontSize:11,color:"#34d399",fontWeight:700,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:6}}>🎯 You could be debt-free in</div>
                  <div style={{fontSize:36,fontWeight:800,color:"#fff",letterSpacing:"-1px",lineHeight:1.1,marginBottom:4}}>{debtFreeProjection.words}</div>
                  <div style={{fontSize:13,color:"#64748b"}}>by {debtFreeProjection.date} · at minimum payments</div>
                </div>
              )}

              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:8}}>Total Remaining</div>
                <div style={{fontSize:38,fontWeight:800,color:"#fff",letterSpacing:"-2px"}}>{formatCurrency(totalDebt)}</div>
                <div style={{margin:"10px 0 4px"}}><ProgressBar percent={overallProgress} color="linear-gradient(90deg,#6366f1,#a78bfa)" /></div>
                <div style={{fontSize:12,color:"#475569"}}>{formatCurrency(totalPaid)} paid · {overallProgress.toFixed(1)}% complete</div>
              </div>

              {nextStep&&(
                <div style={{background:"#6366f115",border:"1px solid #6366f130",borderRadius:14,padding:"14px 16px",marginBottom:16,cursor:nextStep.action?"pointer":"default"}} onClick={nextStep.action||undefined}>
                  <div style={{fontSize:11,color:"#6366f1",fontWeight:700,letterSpacing:"0.5px",marginBottom:4}}>WHAT TO DO NEXT</div>
                  <div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.5}}><span style={{marginRight:6}}>{nextStep.icon}</span>{nextStep.text}</div>
                </div>
              )}

              {debtFreeProjection?.infinite&&(
                <div style={{marginBottom:16}}>
                  <button onClick={()=>setShowPayoffIssues(v=>!v)} style={{width:"100%",background:"#f9731615",border:"1px solid #f9731640",borderRadius:16,padding:"14px 16px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left"}}>
                    <span style={{fontSize:22}}>⚠️</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#f97316"}}>{debtFreeProjection.problemDebts.length} debt{debtFreeProjection.problemDebts.length!==1?"s":""} won't clear at current payments</div>
                      <div style={{fontSize:11,color:"#64748b",marginTop:2}}>Tap to see the fix</div>
                    </div>
                    <span style={{fontSize:14,color:"#64748b",transform:showPayoffIssues?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▾</span>
                  </button>
                  {showPayoffIssues&&(
                    <div style={{background:"#12122a",border:"1px solid #f9731640",borderTop:"none",borderRadius:"0 0 16px 16px",padding:"0 16px 16px"}}>
                      <div style={{borderTop:"1px solid #1e1e3a",paddingTop:14}}>
                        {debtFreeProjection.problemDebts.map((d,i)=>(
                          <div key={d.id} style={{background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:12,padding:14,marginBottom:i<debtFreeProjection.problemDebts.length-1?10:0}}>
                            <div style={S.row}>
                              <div><div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>{d.name}</div><div style={{fontSize:11,color:typeColor(d.type),textTransform:"uppercase",fontWeight:600}}>{d.type}</div></div>
                              <div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:700,color:"#fff"}}>{formatCurrency(d.balance)}</div><div style={{fontSize:11,color:"#64748b"}}>{d.interestRate}% APR</div></div>
                            </div>
                            <div style={{background:"#34d39910",border:"1px solid #34d39930",borderRadius:8,padding:"8px 12px",marginTop:10}}>
                              <div style={{fontSize:12,color:"#34d399",fontWeight:600,marginBottom:2}}>The fix</div>
                              <div style={{fontSize:12,color:"#94a3b8"}}>Pay at least <strong style={{color:"#34d399"}}>{formatCurrency(d.recommended)}/mo</strong> to clear in {d.targetMonths} months</div>
                            </div>
                            <button style={{...S.btn("primary"),width:"100%",marginTop:10,fontSize:12,padding:"10px"}} onClick={async()=>{
                              const updated={...d,minimumPayment:Math.ceil(d.recommended*100)/100,useAutoMin:false};
                              await supabase.from("debts").update(mapToDb(updated,session?.user?.id)).eq("id",d.id);
                              setDebts(prev=>prev.map(debt=>debt.id===d.id?updated:debt));
                            }}>Apply recommended payment</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16,gridAutoRows:"auto"}}>
                <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:14,padding:14}}><div style={{fontSize:10,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:4}}>Active Debts</div><div style={{fontSize:24,fontWeight:700,color:"#fff"}}>{activeDebts.length}</div><div style={{fontSize:11,color:"#64748b"}}>{completedDebts.length>0?`${completedDebts.length} paid off ✓`:"none cleared yet"}</div></div>
                <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:14,padding:14}}><div style={{fontSize:10,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:4}}>Highest Rate</div><div style={{fontSize:24,fontWeight:700,color:"#f97316"}}>{activeDebts.length?Math.max(...activeDebts.map(d=>Number(d.interestRate))).toFixed(1)+"%":"—"}</div><div style={{fontSize:11,color:"#64748b"}}>APR</div></div>
                <div style={{background:"#12122a",border:showTimeline?"1px solid #6366f1":"1px solid #1e1e3a",borderRadius:14,padding:14,cursor:"pointer"}} onClick={()=>setShowTimeline(v=>!v)}>
                  <div style={{fontSize:10,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:4}}>Min Monthly</div>
                  <div style={{fontSize:24,fontWeight:700,color:"#fff"}}>{formatCurrency(totalMinPayment)}</div>
                  <div style={{fontSize:11,color:"#6366f1",marginTop:3}}>{showTimeline?"▴ hide":"▾ see timeline"}</div>
                </div>
                <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:14,padding:14}}><div style={{fontSize:10,color:"#475569",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:4}}>Paid So Far</div><div style={{fontSize:24,fontWeight:700,color:"#34d399"}}>{formatCurrency(totalPaid)}</div><div style={{fontSize:11,color:"#64748b"}}>{overallProgress.toFixed(0)}% done</div></div>
              </div>

              {showTimeline&&(()=>{
                const timeline=buildPaymentTimeline(sortedDebts);
                if (timeline.length<=1) return null;
                return (
                  <div style={{background:"#12122a",border:"1px solid #6366f1",borderRadius:14,padding:16,marginBottom:16}}>
                    <div style={{fontSize:12,fontWeight:700,color:"#fff",marginBottom:4}}>Monthly Payment Timeline</div>
                    <div style={{fontSize:11,color:"#475569",marginBottom:14}}>Your monthly commitment drops as each debt clears</div>
                    {timeline.map((m,i,arr)=>{
                      const isFirst=i===0,isLast=i===arr.length-1;
                      const prev=i>0?arr[i-1]:null;
                      const drop=prev?prev.total-m.total:0;
                      const barWidth=arr[0].total>0?(m.total/arr[0].total)*100:0;
                      return (
                        <div key={i} style={{display:"flex",gap:10,marginBottom:isLast?0:4}}>
                          <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:16,flexShrink:0}}>
                            <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,marginTop:4,background:isLast&&m.total===0?"#34d399":isFirst?"#6366f1":"#a78bfa",boxShadow:isLast&&m.total===0?"0 0 6px #34d39966":"none"}} />
                            {!isLast&&<div style={{width:2,flex:1,background:"#1e1e3a",marginTop:2}} />}
                          </div>
                          <div style={{flex:1,paddingBottom:isLast?0:14}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                              <div>
                                <div style={{fontSize:12,fontWeight:700,color:isFirst?"#a78bfa":"#e2e8f0"}}>{isFirst?"Today":m.label}</div>
                                {m.cleared&&m.cleared.map(d=><div key={d.id} style={{fontSize:10,color:"#34d399",marginTop:1}}>✓ {d.name} cleared</div>)}
                                {isLast&&m.total===0&&<div style={{fontSize:10,color:"#34d399",marginTop:1}}>🎉 Debt free!</div>}
                              </div>
                              <div style={{textAlign:"right"}}>
                                <div style={{fontSize:13,fontWeight:800,color:isLast&&m.total===0?"#34d399":"#fff"}}>{isLast&&m.total===0?"£0/mo":formatCurrency(m.total)+"/mo"}</div>
                                {drop>0&&<div style={{fontSize:10,color:"#34d399",fontWeight:600}}>↓ {formatCurrency(drop)} less</div>}
                              </div>
                            </div>
                            {m.total>0&&<div style={{background:"#0d0d17",borderRadius:999,height:3,overflow:"hidden"}}><div style={{width:`${barWidth}%`,height:"100%",borderRadius:999,background:isFirst?"#6366f1":isLast&&m.total===0?"#34d399":"#a78bfa"}} /></div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <div style={{background:"linear-gradient(135deg,#22d3ee12,#6366f112)",border:"1px solid #22d3ee35",borderRadius:16,padding:"16px 18px",marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:showBudgetInput?12:0}}>
                  <div>
                    <div style={{fontSize:11,color:"#22d3ee",fontWeight:700,letterSpacing:"0.5px",marginBottom:2}}>💰 BUDGET ACCELERATOR</div>
                    {budgetIncome>0&&!showBudgetInput?(<div><div style={{fontSize:20,fontWeight:800,color:"#22d3ee"}}>{budgetProjection&&!budgetProjection.shortfall?`Free in ${monthsToWords(budgetProjection.months)}`:"Budget shortfall"}</div><div style={{fontSize:12,color:"#64748b",marginTop:2}}>{formatCurrency(budgetMonthlyExtra)}/mo surplus to debt</div></div>):(<div style={{fontSize:13,color:"#64748b"}}>Enter your income to see how fast you can clear everything</div>)}
                  </div>
                  <button style={{background:"#22d3ee20",border:"1px solid #22d3ee40",borderRadius:8,color:"#22d3ee",fontSize:11,fontWeight:600,cursor:"pointer",padding:"6px 10px",flexShrink:0}} onClick={()=>setShowBudgetInput(v=>!v)}>{showBudgetInput?"Done":"Set budget"}</button>
                </div>
                {showBudgetInput&&(
                  <div>
                    <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Monthly take-home pay (£)</div>
                    <input style={{...S.input,marginBottom:10}} type="number" placeholder="e.g. 3000" value={budgetIncome||""} onChange={e=>setBudgetIncome(Number(e.target.value)||0)} />
                    <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Monthly fixed expenses (£)</div>
                    <input style={{...S.input,marginBottom:0}} type="number" placeholder="e.g. 1200" value={budgetExpenses||""} onChange={e=>setBudgetExpenses(Number(e.target.value)||0)} />
                    {budgetIncome>0&&(
                      <div style={{marginTop:10,borderTop:"1px solid #22d3ee20",paddingTop:10}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:12,color:"#475569"}}>Take-home</span><span style={{fontSize:12,color:"#e2e8f0",fontWeight:600}}>{formatCurrency(budgetIncome)}</span></div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:12,color:"#475569"}}>Fixed expenses</span><span style={{fontSize:12,color:"#e2e8f0"}}>− {formatCurrency(budgetExpenses)}</span></div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:12,color:"#475569"}}>Debt minimums</span><span style={{fontSize:12,color:"#e2e8f0"}}>− {formatCurrency(totalMinPayment)}</span></div>
                        <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #1e1e3a",paddingTop:6}}><span style={{fontSize:13,fontWeight:700,color:budgetMonthlyExtra>0?"#22d3ee":"#f43f5e"}}>Available for debt</span><span style={{fontSize:14,fontWeight:800,color:budgetMonthlyExtra>0?"#22d3ee":"#f43f5e"}}>{budgetMonthlyExtra>0?formatCurrency(budgetMonthlyExtra)+"/mo":"Shortfall"}</span></div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {priorityDebt&&(()=>{
                return (
                  <div style={S.card}>
                    <div style={S.priorityBadge}>⚡ Priority Debt</div>
                    {activeDebts.length>1&&(
                      <div style={{marginBottom:14}}>
                        <div style={{fontSize:11,color:"#64748b",marginBottom:6}}>Select debt to pay:</div>
                        <select value={selId} onChange={e=>setDashboardPaymentDebt(e.target.value)} style={{width:"100%",background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:8,padding:"8px 10px",color:"#e2e8f0",fontSize:13}}>
                          {sortedDebts.map(d=><option key={d.id} value={String(d.id)}>{d.name} — {formatCurrency(d.balance)}</option>)}
                        </select>
                      </div>
                    )}
                    <div style={S.row}>
                      <div><div style={{fontSize:16,fontWeight:700,color:"#f1f5f9",marginBottom:2}}>{displayDebt?.name}</div><div style={{fontSize:11,fontWeight:600,color:typeColor(displayDebt?.type),textTransform:"uppercase"}}>{displayDebt?.type}</div></div>
                      <div style={{textAlign:"right"}}><div style={{fontSize:20,fontWeight:800,color:"#fff"}}>{formatCurrency(displayDebt?.balance)}</div><div style={{fontSize:12,color:"#64748b"}}>{displayDebt?.interestRate}% APR</div></div>
                    </div>
                    <div style={{marginTop:12}}><ProgressBar percent={debtProgress(displayDebt)} color={typeColor(displayDebt?.type)} /></div>
                    <div style={{fontSize:12,color:"#475569",marginTop:6}}>Min payment: {formatCurrency(displayDebt?.minimumPayment)}/mo</div>
                    <button style={{...S.btn("primary"),marginTop:14,width:"100%"}} onClick={()=>{setPaymentModal(displayDebt);setPaymentAmount("");}}>Log Payment — {displayDebt?.name}</button>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {activeTab==="debts"&&(
        <div style={S.section}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,marginTop:4}}>
            <div style={{display:"flex",background:"#0d0d17",borderRadius:10,padding:3,border:"1px solid #1e1e3a",flex:1,marginRight:12,position:"relative"}} onClick={!isPremium?()=>setShowUpgrade(true):undefined}>
              <button style={{flex:1,padding:"7px 6px",borderRadius:8,border:"none",cursor:isPremium?"pointer":"not-allowed",fontSize:12,fontWeight:600,background:strategy==="avalanche"?"#6366f1":"transparent",color:strategy==="avalanche"?"#fff":"#475569",transition:"all 0.2s",opacity:isPremium?1:0.5}} onClick={isPremium?()=>setStrategy("avalanche"):undefined}>🔥 Avalanche</button>
              <button style={{flex:1,padding:"7px 6px",borderRadius:8,border:"none",cursor:isPremium?"pointer":"not-allowed",fontSize:12,fontWeight:600,background:strategy==="snowball"?"#6366f1":"transparent",color:strategy==="snowball"?"#fff":"#475569",transition:"all 0.2s",opacity:isPremium?1:0.5}} onClick={isPremium?()=>setStrategy("snowball"):undefined}>❄️ Snowball {!isPremium&&"✦"}</button>
            </div>
            <select value={debtSort} onChange={e=>setDebtSort(e.target.value)} style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:8,padding:"7px 10px",color:"#e2e8f0",fontSize:12,cursor:"pointer"}}>
              <option value="type">By type</option>
              <option value="balance_desc">Highest balance</option>
              <option value="balance_asc">Lowest balance</option>
              <option value="apr_desc">Highest APR</option>
              <option value="apr_asc">Lowest APR</option>
              <option value="payment_desc">Highest payment</option>
              <option value="payment_asc">Lowest payment</option>
              <option value="name">A–Z</option>
            </select>
          </div>

          {sortedDebtsView.length===0&&completedDebts.length===0&&<div style={S.emptyState}><div style={{fontSize:40,marginBottom:12}}>💳</div><div style={{fontSize:16,fontWeight:600,color:"#64748b"}}>No debts yet</div></div>}

          {sortedDebtsView.map((debt,i)=>{
            const goalPmt=isPremium&&debt.payoffGoalMonths?calcGoalPayment(debt.balance,debt.interestRate,debt.payoffGoalMonths):null;
            const extra=goalPmt?goalPmt-Number(debt.minimumPayment):null;
            const due=debt.paymentDueDay?nextDueDate(debt.paymentDueDay):null;
            const pendingChanges=(debt.rateChanges||[]).filter(rc=>!rc.applied);
            return (
              <div key={debt.id} style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:16,padding:18,marginBottom:12,position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,left:0,width:4,height:"100%",background:typeColor(debt.type),borderRadius:"16px 0 0 16px"}} />
                <div style={{paddingLeft:8}}>
                  <div style={S.row}>
                    <div><div style={{fontSize:16,fontWeight:700,color:"#f1f5f9",marginBottom:2}}>{debt.name}</div><div style={{fontSize:11,fontWeight:600,color:typeColor(debt.type),textTransform:"uppercase"}}>{debt.type}</div></div>
                    <div style={S.pill(typeColor(debt.type))}>{debt.interestRate}% APR</div>
                  </div>
                  <div style={{fontSize:24,fontWeight:800,color:"#fff",letterSpacing:"-1px",margin:"10px 0 4px"}}>{formatCurrency(debt.balance)}</div>
                  <div style={{marginBottom:8}}>
                    <ProgressBar percent={debtProgress(debt)} color={typeColor(debt.type)} />
                    <div style={{fontSize:11,color:"#475569",marginTop:5,display:"flex",justifyContent:"space-between"}}>
                      <span>{formatCurrency(Number(debt.originalBalance||debt.balance)-Number(debt.balance))} paid · {debtProgress(debt).toFixed(1)}%</span>
                      {debt.remainingMonths&&<span>{debt.remainingMonths} mo left</span>}
                    </div>
                  </div>
                  <div style={{fontSize:12,color:"#475569",marginBottom:8}}>
                    Min: <strong style={{color:"#94a3b8"}}>{formatCurrency(debt.minimumPayment)}/mo</strong>
                    {due&&<span style={{marginLeft:8,color:due.daysUntil<=3?"#f97316":"#475569",fontWeight:due.daysUntil<=3?700:400}}>· due {ordinal(debt.paymentDueDay)}{due.daysUntil<=7&&<span style={{color:due.daysUntil===0?"#f43f5e":due.daysUntil<=3?"#f97316":"#64748b"}}> ({due.daysUntil===0?"today!":due.daysUntil===1?"tomorrow":`${due.daysUntil}d`})</span>}</span>}
                  </div>
                  {goalPmt&&(
                    <div style={{background:"#a78bfa15",border:"1px solid #a78bfa35",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                      <div style={{fontSize:11,color:"#a78bfa",fontWeight:700,marginBottom:8}}>🎯 Clear by {dateInMonths(debt.payoffGoalMonths)}</div>
                      <div style={{display:"flex",flexDirection:"column",gap:4}}>
                        <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:12,color:"#64748b"}}>Minimum payment</span><span style={{fontSize:12,color:"#94a3b8",fontWeight:600}}>{formatCurrency(debt.minimumPayment)}/mo</span></div>
                        <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:12,color:"#64748b"}}>Extra to hit goal</span><span style={{fontSize:12,color:"#a78bfa",fontWeight:600}}>+ {formatCurrency(extra)}/mo</span></div>
                        <div style={{borderTop:"1px solid #a78bfa30",paddingTop:6,display:"flex",justifyContent:"space-between"}}><span style={{fontSize:13,fontWeight:700,color:"#fff"}}>Total to pay</span><span style={{fontSize:13,fontWeight:800,color:"#fff"}}>{formatCurrency(goalPmt)}/mo</span></div>
                      </div>
                    </div>
                  )}
                  {!isPremium&&debt.payoffGoalMonths&&(
                    <div style={{background:"#6366f115",border:"1px solid #6366f130",borderRadius:10,padding:"8px 12px",marginBottom:10,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <span style={{fontSize:12,color:"#6366f1"}}>🔒 Goal set — unlock to see payment breakdown</span>
                      <button style={{background:"#6366f1",border:"none",borderRadius:6,color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 10px"}} onClick={()=>setShowUpgrade(true)}>Upgrade</button>
                    </div>
                  )}
                  {pendingChanges.map((rc,j)=>(
                    <div key={j} style={{background:"#fbbf2410",border:"1px solid #fbbf2430",borderRadius:8,padding:"6px 10px",fontSize:11,color:"#fbbf24",marginBottom:4}}>⏰ Rate → {rc.newRate}% on {formatDate(rc.date)}</div>
                  ))}
                  {(()=>{
                    const today=new Date();
                    const thisMonthAuto=(debt.payments||[]).find(p=>{
                      if (!p.auto) return false;
                      const d=new Date(p.date);
                      return d.getFullYear()===today.getFullYear()&&d.getMonth()===today.getMonth();
                    });
                    if (!thisMonthAuto) return null;
                    return <div style={{background:"#34d39910",border:"1px solid #34d39930",borderRadius:8,padding:"6px 10px",fontSize:11,color:"#34d399",marginBottom:8}}>✅ Minimum payment of {formatCurrency(thisMonthAuto.amount)} auto-applied this month</div>;
                  })()}
                  <div style={{display:"flex",gap:8}}>
                    <button style={{...S.btn("primary"),flex:2}} onClick={()=>{setPaymentModal(debt);setPaymentAmount("");}}>+ Extra Payment</button>
                    <button style={{...S.btn("sm"),flex:1}} onClick={()=>handleEdit(debt)}>Edit</button>
                    <button style={{...S.btn("danger"),flex:1}} onClick={()=>handleDelete(debt.id)}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}

          {completedDebts.length>0&&(
            <div style={{marginTop:8}}>
              <button style={{width:"100%",background:"transparent",border:"none",color:"#34d399",fontSize:13,fontWeight:600,cursor:"pointer",padding:"10px 0",display:"flex",alignItems:"center",justifyContent:"center",gap:6}} onClick={()=>setShowArchived(v=>!v)}>
                ✓ {completedDebts.length} paid off {showArchived?"▴":"▾"}
              </button>
              {showArchived&&completedDebts.map(debt=>(
                <div key={debt.id} style={{background:"#12122a",border:"1px solid #34d39930",borderRadius:14,padding:16,marginBottom:10,opacity:0.7}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <div><div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{debt.name}</div><div style={{fontSize:11,color:"#34d399",fontWeight:600}}>✓ PAID OFF</div></div>
                    <div style={{textAlign:"right"}}><div style={{fontSize:14,color:"#34d399",fontWeight:700}}>{formatCurrency(Number(debt.originalBalance||debt.balance))} cleared</div></div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button style={{...S.btn("danger"),flex:1,fontSize:12,padding:"8px"}} onClick={()=>handleDelete(debt.id)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{marginTop:16,background:"#12122a",border:"1px solid #1e1e3a",borderRadius:14,padding:16}}>
            <div style={{fontSize:13,fontWeight:700,color:"#fff",marginBottom:4}}>Data & Backup <span style={{fontSize:10,color:"#6366f1",fontWeight:600}}>✦ Premium</span></div>
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              <button style={{...S.btn("default"),flex:1,opacity:(!isPremium||debts.length===0)?0.4:1}} onClick={isPremium?()=>exportData("json"):()=>setShowUpgrade(true)} disabled={debts.length===0}>⬇ Backup</button>
              <button style={{...S.btn("default"),flex:1,opacity:(!isPremium||debts.length===0)?0.4:1}} onClick={isPremium?()=>exportData("csv"):()=>setShowUpgrade(true)} disabled={debts.length===0}>⬇ CSV</button>
            </div>
            {isPremium&&(
              <label style={{display:"block",background:"#1e1e3a",borderRadius:10,padding:"11px",textAlign:"center",cursor:"pointer",fontSize:13,color:"#94a3b8"}}>
                ⬆ Restore from backup
                <input type="file" accept=".json" onChange={importData} style={{display:"none"}} />
              </label>
            )}
          </div>
        </div>
      )}

      {activeTab==="summary"&&(
        <div style={S.section}>
          <div style={{marginTop:4,marginBottom:20}}>
            <div style={{fontSize:18,fontWeight:700,color:"#fff",marginBottom:4}}>Pay Faster ✦</div>
            <div style={{fontSize:13,color:"#475569"}}>See what a little extra does to your debt-free date</div>
          </div>
          {activeDebts.length===0?(
            <div style={S.emptyState}><div style={{fontSize:40,marginBottom:12}}>⚡</div><div style={{fontSize:16,fontWeight:600,color:"#64748b"}}>Add debts to see your simulation</div></div>
          ):(
            <SliderSection debts={activeDebts} strategy={strategy} sortedDebts={sortedDebts} totalMinPayment={totalMinPayment} debtFreeProjection={debtFreeProjection} formatCurrency={formatCurrency} S={S} />
          )}
        </div>
      )}

      <button style={S.fab} onClick={()=>{
        if (!isPremium&&activeDebts.length>=FREE_LIMIT){setShowUpgrade(true);return;}
        setShowForm(true);setEditingId(null);setForm(initialForm);
      }}>
        <span style={{fontSize:18}}>{!isPremium&&activeDebts.length>=FREE_LIMIT?"🔒":"+"}</span>
        {!isPremium&&activeDebts.length>=FREE_LIMIT?"Unlock to add more":"Add Debt"}
      </button>

      {showUpgrade&&(
        <div style={S.modal} onClick={()=>setShowUpgrade(false)}>
          <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{fontSize:26,marginBottom:6}}>✦</div>
              <div style={{fontSize:22,fontWeight:800,color:"#fff",letterSpacing:"-0.5px"}}>Clear your debt years sooner</div>
              <div style={{fontSize:13,color:"#475569",marginTop:6}}>Everything unlocked. Cancel anytime.</div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
              <div style={{background:"#12122a",border:"1px solid #1e1e3a",borderRadius:14,padding:16,position:"relative",cursor:"pointer"}} onClick={()=>{window.location.href="https://buy.stripe.com/5kQ00jcfv39o84W1pn4ow01";}}>
                <div style={{fontSize:10,color:"#64748b",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:8}}>Monthly</div>
                <div style={{fontSize:28,fontWeight:800,color:"#fff",letterSpacing:"-1px"}}>£2.99</div>
                <div style={{fontSize:11,color:"#475569",marginTop:2}}>/month</div>
                <div style={{fontSize:11,color:"#475569",marginTop:8,lineHeight:1.5}}>Flexible · cancel anytime</div>
                <button style={{width:"100%",background:"#1e1e3a",color:"#e2e8f0",border:"none",borderRadius:10,padding:"10px",fontSize:13,fontWeight:600,cursor:"pointer",marginTop:12}}>Start monthly</button>
              </div>
              <div style={{background:"linear-gradient(135deg,#6366f118,#a78bfa12)",border:"2px solid #6366f1",borderRadius:14,padding:16,position:"relative",cursor:"pointer"}} onClick={()=>{window.location.href="https://buy.stripe.com/6oUcN54N3fWa70S8RP4ow02";}}>
                <div style={{position:"absolute",top:-10,left:"50%",transform:"translateX(-50%)",background:"#6366f1",color:"#fff",fontSize:10,fontWeight:700,borderRadius:999,padding:"3px 10px",whiteSpace:"nowrap"}}>BEST VALUE</div>
                <div style={{fontSize:10,color:"#a78bfa",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:8}}>Yearly</div>
                <div style={{fontSize:28,fontWeight:800,color:"#fff",letterSpacing:"-1px"}}>£19.99</div>
                <div style={{fontSize:11,color:"#475569",marginTop:2}}>per year</div>
                <div style={{fontSize:11,color:"#34d399",marginTop:8,lineHeight:1.5}}>Save £15.89/yr vs monthly · cancel anytime</div>
                <button style={{width:"100%",background:"#6366f1",color:"#fff",border:"none",borderRadius:10,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",marginTop:12}}>Get yearly access</button>
              </div>
            </div>

            <div style={{borderTop:"1px solid #1e1e3a",paddingTop:16,marginBottom:16}}>
              <div style={{fontSize:11,color:"#475569",fontWeight:600,letterSpacing:"0.5px",marginBottom:12}}>SETTLED PREMIUM INCLUDES</div>
              {[["⚡","Pay Faster slider","See your debt-free date with any extra amount"],["🎯","Payoff goals","Set a clear-by date per debt with full breakdown"],["🔥","Strategy comparison","Avalanche vs snowball"],["💰","Budget Accelerator","Debt-free date based on your real budget"],["✦","Unlimited debts","Track every loan, card, and liability"],["⬇","Backup & export","JSON and CSV anytime"]].map(([icon,title,sub])=>(
                <div key={title} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                  <div style={{width:28,height:28,borderRadius:8,background:"#6366f115",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>{icon}</div>
                  <div><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{title}</div><div style={{fontSize:11,color:"#475569"}}>{sub}</div></div>
                </div>
              ))}
            </div>

            <div style={{fontSize:11,color:"#334155",textAlign:"center",marginBottom:8}}>🔒 Secure payment via Stripe · No hidden fees</div>
            <div style={{display:"flex",justifyContent:"center",gap:16",marginBottom:8}}>
              <a href="/privacy.html" target="_blank" style={{fontSize:11,color:"#475569",textDecoration:"none"}}>Privacy Policy</a>
              <a href="/terms.html" target="_blank" style={{fontSize:11,color:"#475569",textDecoration:"none"}}>Terms & Conditions</a>
            </div>
            <button style={{...S.btn("ghost"),width:"100%"}} onClick={()=>setShowUpgrade(false)}>Maybe later</button>
          </div>
        </div>
      )}

      {showForm&&(
        <div style={S.modal} onClick={()=>setShowForm(false)}>
          <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:18,fontWeight:700,color:"#fff",marginBottom:20}}>{editingId?"Edit Debt":"Add New Debt"}</div>
            <label style={S.label}>Debt Name</label>
            <input style={S.input} name="name" placeholder="e.g. Barclaycard, Car Loan" value={form.name} onChange={fc} />
            <label style={S.label}>Type</label>
            <select style={S.select} name="type" value={form.type} onChange={fc}>{DEBT_TYPES.map(t=><option key={t}>{t}</option>)}</select>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <div><label style={{...S.label,marginBottom:6}}>Balance (£)</label><input style={{...S.input,marginBottom:0}} name="balance" type="number" placeholder="0.00" value={form.balance} onChange={fc} /></div>
              <div><label style={{...S.label,marginBottom:6}}>APR (%)</label><input style={{...S.input,marginBottom:0}} name="interestRate" type="number" placeholder="0.0" value={form.interestRate} onChange={fc} /></div>
            </div>
            {!isRevolving(form.type)&&(
              <>
                <label style={S.label}>Loan start date <span style={{color:"#334155",fontWeight:400}}>— optional</span></label>
                <input style={{...S.input,colorScheme:"dark"}} name="startDate" type="date" value={form.startDate} onChange={fc} max={new Date().toISOString().split("T")[0]} />
                <label style={S.label}>Loan term (months) <span style={{color:"#334155",fontWeight:400}}>— optional</span></label>
                <input style={S.input} name="totalTermMonths" type="number" placeholder="e.g. 36 or 60" value={form.totalTermMonths} onChange={fc} />
              </>
            )}
            <button style={{width:"100%",background:"#1e1e3a",border:"none",borderRadius:10,padding:"10px 14px",color:form.showAdvanced?"#a78bfa":"#64748b",fontSize:12,fontWeight:600,cursor:"pointer",marginBottom:form.showAdvanced?14:20,display:"flex",alignItems:"center",justifyContent:"space-between"}} onClick={()=>setForm(f=>({...f,showAdvanced:!f.showAdvanced}))}>
              <span>{form.showAdvanced?"▴":"▾"} Advanced options</span>
              <span style={{fontSize:11,color:"#334155"}}>goals · due date · rate changes</span>
            </button>
            {form.showAdvanced&&(
              <div>
                <div style={{marginBottom:14}}>
                  <div style={{background:"#6366f115",border:"1px solid #6366f140",borderRadius:10,padding:"10px 14px",marginBottom:form.useAutoMin?0:10,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div><div style={{fontSize:12,color:"#6366f1",fontWeight:600}}>Auto-calculate minimum</div><div style={{fontSize:11,color:"#475569",marginTop:2}}>{form.useAutoMin?`Est. ${formatCurrency(autoMin)}/mo`:"Enter manually"}</div></div>
                    <input type="checkbox" name="useAutoMin" checked={form.useAutoMin} onChange={fc} style={{width:18,height:18,accentColor:"#6366f1",cursor:"pointer"}} />
                  </div>
                  {!form.useAutoMin&&<div style={{marginTop:10}}><label style={S.label}>Custom minimum (£/mo)</label><input style={S.input} name="customMinPayment" type="number" placeholder="0.00" value={form.customMinPayment} onChange={fc} /></div>}
                </div>
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <label style={{...S.label,marginBottom:0}}>Payoff goal (clear by)</label>
                    {!isPremium&&<span style={{fontSize:10,color:"#6366f1",background:"#6366f115",border:"1px solid #6366f130",borderRadius:999,padding:"2px 8px",fontWeight:600}}>✦ Premium</span>}
                  </div>
                  {isPremium?(
                    <select style={{...S.select,marginBottom:0}} name="payoffGoalMonths" value={form.payoffGoalMonths} onChange={fc}>
                      <option value="">No goal</option>
                      {[3,6,12,18,24,36,48,60].map(m=><option key={m} value={m}>Clear in {m} months</option>)}
                    </select>
                  ):(
                    <button style={{width:"100%",background:"#6366f115",border:"1px solid #6366f130",borderRadius:10,padding:"12px",color:"#6366f1",fontSize:13,fontWeight:600,cursor:"pointer"}} onClick={()=>{setShowForm(false);setShowUpgrade(true);}}>🔒 Upgrade to set payoff goals</button>
                  )}
                </div>
                <div style={{marginBottom:14}}>
                  <label style={S.label}>Monthly payment date</label>
                  <select style={{...S.select,marginBottom:0}} name="paymentDueDay" value={form.paymentDueDay} onChange={fc}>
                    <option value="">Not set</option>
                    {Array.from({length:31},(_,i)=>i+1).map(d=><option key={d} value={d}>{ordinal(d)} of each month</option>)}
                  </select>
                </div>
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:12,color:"#64748b",fontWeight:600,letterSpacing:"0.5px",marginBottom:8,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span>SCHEDULED RATE CHANGES</span>
                    <button style={{...S.btn("outline"),padding:"4px 10px",fontSize:11}} onClick={()=>setShowRateChange(r=>!r)}>+ Add</button>
                  </div>
                  {form.rateChanges.length===0&&!showRateChange&&<div style={{fontSize:12,color:"#334155",fontStyle:"italic"}}>e.g. 0% promo ending, mortgage fix expiring</div>}
                  {form.rateChanges.map((rc,i)=>(
                    <div key={i} style={{background:"#fbbf2415",border:"1px solid #fbbf2440",borderRadius:10,padding:"8px 12px",marginBottom:8,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div><div style={{fontSize:12,fontWeight:600,color:"#fbbf24"}}>→ {rc.newRate}% on {formatDate(rc.date)}</div>{rc.label&&<div style={{fontSize:11,color:"#64748b"}}>{rc.label}</div>}</div>
                      <button style={{...S.btn("danger"),padding:"4px 10px",fontSize:11}} onClick={()=>removeRateChange(i)}>✕</button>
                    </div>
                  ))}
                  {showRateChange&&(
                    <div style={{background:"#0d0d17",border:"1px solid #1e1e3a",borderRadius:12,padding:14,marginTop:8}}>
                      <label style={S.label}>Change Date</label>
                      <input style={{...S.input,colorScheme:"dark"}} type="date" value={rateChangeForm.date} onChange={e=>setRateChangeForm(f=>({...f,date:e.target.value}))} />
                      <label style={S.label}>New Rate (% APR)</label>
                      <input style={S.input} type="number" placeholder="e.g. 27.9" value={rateChangeForm.newRate} onChange={e=>setRateChangeForm(f=>({...f,newRate:e.target.value}))} />
                      <label style={S.label}>Label (optional)</label>
                      <input style={S.input} placeholder="e.g. End of 0% promo" value={rateChangeForm.label} onChange={e=>setRateChangeForm(f=>({...f,label:e.target.value}))} />
                      <div style={{display:"flex",gap:8}}>
                        <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setShowRateChange(false)}>Cancel</button>
                        <button style={{...S.btn("primary"),flex:2}} onClick={addRateChange}>Save</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div style={{display:"flex",gap:10}}>
              <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setShowForm(false)}>Cancel</button>
              <button style={{...S.btn("primary"),flex:2,opacity:saving?0.6:1}} onClick={handleAddOrEdit} disabled={saving}>
                {saving?"Saving…":editingId?"Save Changes":"Add Debt"}
              </button>
            </div>
          </div>
        </div>
      )}

      {paymentModal&&(
        <div style={S.modal} onClick={()=>setPaymentModal(null)}>
          <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:18,fontWeight:700,color:"#fff",marginBottom:4}}>Log Payment</div>
            <div style={{fontSize:13,color:"#475569",marginBottom:20}}>{paymentModal.name} · {formatCurrency(paymentModal.balance)} remaining</div>
            <label style={S.label}>Payment Amount (£)</label>
            <input style={S.input} type="number" placeholder={`Suggested: £${Number(paymentModal.minimumPayment).toFixed(2)}/mo`} value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)} autoFocus />
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              {[[paymentModal.minimumPayment,"Min"],[isPremium&&paymentModal.payoffGoalMonths?calcGoalPayment(paymentModal.balance,paymentModal.interestRate,paymentModal.payoffGoalMonths):(Number(paymentModal.minimumPayment)*1.5).toFixed(0),isPremium&&paymentModal.payoffGoalMonths?"🎯 Goal":"1.5×"],[paymentModal.balance,"Full"]].map(([v,label],i)=>(
                <button key={i} style={{...S.btn("sm"),flex:1,fontSize:11}} onClick={()=>setPaymentAmount(String(Number(v).toFixed(2)))}>{label}<br/>£{Number(v).toFixed(0)}</button>
              ))}
            </div>
            <div style={{fontSize:11,color:"#475569",marginBottom:16}}>New balance: <strong style={{color:"#e2e8f0"}}>{formatCurrency(Math.max(0,Number(paymentModal.balance)-Number(paymentAmount||0)))}</strong></div>
            {(()=>{
              const amt=Number(paymentAmount||0),min=Number(paymentModal.minimumPayment||0),extra=amt-min;
              if (extra<=0||!paymentModal.interestRate) return null;
              const base=simulatePayoff(paymentModal.balance,paymentModal.interestRate,min,paymentModal.rateChanges);
              const upgraded=simulatePayoff(paymentModal.balance,paymentModal.interestRate,amt,paymentModal.rateChanges);
              if (!isFinite(base.months)||!isFinite(upgraded.months)) return null;
              const saved=base.interest-upgraded.interest,monthsSaved=base.months-upgraded.months;
              if (saved<=0&&monthsSaved<=0) return null;
              return (
                <div style={{background:"#34d39912",border:"1px solid #34d39940",borderRadius:10,padding:"10px 14px",marginBottom:16}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#34d399",marginBottom:3}}>💪 Paying £{extra.toFixed(0)} extra</div>
                  <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.6}}>
                    {saved>0&&<>Saves <strong style={{color:"#34d399"}}>{formatCurrency(saved)}</strong> in interest</>}
                    {saved>0&&monthsSaved>0&&" · "}
                    {monthsSaved>0&&<>clears <strong style={{color:"#34d399"}}>{monthsSaved}</strong> month{monthsSaved!==1?"s":""} sooner</>}
                  </div>
                </div>
              );
            })()}
            <div style={{display:"flex",gap:10}}>
              <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setPaymentModal(null)}>Cancel</button>
              <button style={{...S.btn("primary"),flex:2}} onClick={handlePayment}>Confirm Payment</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
