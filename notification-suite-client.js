(()=>{'use strict';
const KEY='abshir_captain_token',CSS='notification-suite-css';
const style=document.createElement('style');style.id=CSS;style.textContent=`
#nsButton{position:fixed;bottom:85px;right:15px;z-index:13000;background:#176b97;color:#fff;border:0;border-radius:14px;padding:12px;box-shadow:0 5px 25px #0007;font-weight:bold}
#nsPanel{position:fixed;inset:10% 12px auto;max-width:480px;margin:auto;z-index:13001;max-height:75vh;overflow:auto;background:#11263b;color:#fff;border:1px solid #4786ad;border-radius:18px;padding:16px;direction:rtl;box-shadow:0 12px 50px #000b}
#nsPanel[hidden],#nsButton[hidden]{display:none!important}
#nsPanel button{background:#2675a3;border:0;border-radius:9px;padding:8px;color:white;cursor:pointer}
.nsItem{padding:10px 4px;border-bottom:1px solid #476078;line-height:1.7}
.nsItem small{display:block;opacity:.7}
.nsItem.unread{border-right:3px solid #66c9ff;padding-right:10px}
`;document.head.append(style);
const button=document.createElement('button');button.id='nsButton';button.hidden=true;button.type='button';button.textContent='🔔 الإشعارات';
const panel=document.createElement('section');panel.id='nsPanel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','مركز الإشعارات');
panel.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center"><strong>🔔 مركز الإشعارات</strong><div><button id="nsReadAll">قراءة الكل</button> <button id="nsClose">✕</button></div></div><div id="nsItems">جاري التحميل...</div>';
document.body.append(button,panel);
const items=panel.querySelector('#nsItems');
async function api(path,method='GET',body){const token=localStorage.getItem(KEY);if(!token)throw Error('سجّل الدخول أولاً');const res=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!res.ok)throw Error('تعذر الاتصال بالخادم');return res.json()}
let busy=false;
async function refresh(){if(busy||!localStorage.getItem(KEY))return;busy=true;try{const data=await api('/api/notifications/inbox');button.textContent='🔔 الإشعارات'+(data.unread?' ('+data.unread+')':'');if(panel.hidden)return;items.replaceChildren();if(!data.notifications.length){items.textContent='لا توجد إشعارات';return}for(const n of data.notifications){const row=document.createElement('div');row.className='nsItem'+(n.read_at?'':' unread');const title=document.createElement('strong');title.textContent=n.title;const body=document.createElement('div');body.textContent=n.body;const date=document.createElement('small');date.textContent=new Date(n.created_at).toLocaleString('ar-JO');row.append(title,body,date);if(typeof n.link==='string'&&n.link.startsWith('/captain')&&!n.link.startsWith('//')){const go=document.createElement('a');go.textContent='فتح التفاصيل ↗';go.href=n.link;go.style.cssText='color:#8fdbff;display:inline-block;margin:5px 0';row.append(go)}if(!n.read_at){const mark=document.createElement('button');mark.textContent='مقروء';mark.onclick=async()=>{await api('/api/notifications/read','POST',{id:Number(n.id)});refresh()};row.append(mark)}items.append(row)}}catch(e){if(!panel.hidden)items.textContent=e.message}finally{busy=false}}
button.onclick=()=>{panel.hidden=false;refresh()};
if(new URLSearchParams(location.search).get('tab')==='notifications'){
  panel.hidden=false;
  history.replaceState(null,'',location.pathname+location.hash);
}
panel.querySelector('#nsClose').onclick=()=>panel.hidden=true;panel.querySelector('#nsReadAll').onclick=async()=>{try{await api('/api/notifications/read-all','POST');refresh()}catch(e){items.textContent=e.message}};
function sync(){button.hidden=!localStorage.getItem(KEY);if(button.hidden)panel.hidden=true;else refresh()}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});window.addEventListener('storage',sync);window.addEventListener('load',sync);setInterval(sync,30000);sync();
})();
