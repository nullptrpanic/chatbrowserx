/** Public, disposable UI fixture. No model/tool scripting or authentication.
 * Start with tsx, then use the ordinary shared live runner against localhost:43871.
 * Restarting resets the synthetic state; the real model must choose every action.
 */
import { createServer } from 'node:http';

const parents: Record<string, string> = {
  Alpha: 'Root',
  Beta: 'Root',
  Gamma: 'Root',
  Hold: 'Root',
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:43871');
  if (request.method === 'POST' && url.pathname === '/move') {
    const name = url.searchParams.get('name') ?? '';
    if (!Object.hasOwn(parents, name)) {
      response.writeHead(400).end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    parents[name] = 'Archive';
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(parents));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Batch workspace</title>
    <style>body{font:16px system-ui;max-width:950px;margin:30px}section{margin:20px 0}button{margin:4px}#tree{height:240px;overflow-y:auto;border:1px solid #aaa;position:relative}#spacer{position:relative}.row{height:40px;box-sizing:border-box;padding:6px 12px;position:absolute;width:90%}dialog{min-width:260px}output{display:block}</style>
    <h1>Batch workspace</h1><p>A document list with delayed moves and a virtualized destination.</p>
    <section aria-label="Root documents"><h2>Root</h2><div id="root"></div></section>
    <section><h2>Archive</h2><div id="tree" role="tree" aria-label="Archive documents" tabindex="0"><div id="spacer"></div></div></section>
    <output aria-live="polite" id="status"></output>
    <dialog><h2>Move document</h2><p id="selection"></p><label>Destination <select><option>Archive</option></select></label><button id="confirm">Confirm move</button><button id="cancel">Cancel</button></dialog>
    <script>
      let parents = ${JSON.stringify(parents)};
      let selected = '';
      const root = document.querySelector('#root'), tree = document.querySelector('#tree'), spacer = document.querySelector('#spacer'), dialog = document.querySelector('dialog'), status = document.querySelector('#status');
      function archiveNames(){ return Array.from({length:24}, (_,i)=>'Existing '+(i+1)).concat(Object.keys(parents).filter(n=>parents[n]==='Archive')); }
      function drawTree(){
        const names=archiveNames(), start=Math.max(0,Math.floor(tree.scrollTop/40)-1), end=Math.min(names.length,start+9);
        spacer.style.height=(names.length*40)+'px'; spacer.replaceChildren();
        for(let i=start;i<end;i++){
          const row=document.createElement('div'); row.className='row'; row.style.top=(i*40)+'px'; row.setAttribute('role','treeitem'); row.setAttribute('aria-level','2'); row.setAttribute('aria-posinset',String(i+1)); row.setAttribute('aria-setsize',String(names.length)); row.dataset.name=names[i]; row.dataset.parent='Archive'; row.textContent=names[i]; spacer.append(row);
        }
      }
      function render(){
        root.replaceChildren();
        for(const name of Object.keys(parents).filter(n=>parents[n]==='Root')){
          const row=document.createElement('div'); row.dataset.name=name; row.dataset.parent='Root';
          const link=document.createElement('a'); link.href='/?item='+name; link.textContent=name; row.append(link);
          const button=document.createElement('button'); button.textContent='Move '+name; button.onclick=()=>{selected=name;document.querySelector('#selection').textContent=name;dialog.showModal();}; row.append(button);root.append(row);
        }
        drawTree();
      }
      document.querySelector('#cancel').onclick=()=>dialog.close();
      document.querySelector('#confirm').onclick=async()=>{
        const name=selected; dialog.close(); status.textContent='Moving '+name+'…';
        parents=await (await fetch('/move?name='+encodeURIComponent(name),{method:'POST'})).json(); render(); status.textContent='Move request finished';
      };
      tree.onscroll=drawTree;render();
      const item=new URL(location.href).searchParams.get('item');
      if(item && parents[item]==='Archive'){tree.scrollTop=archiveNames().indexOf(item)*40;drawTree();}
    </script></html>`);
});
server.listen(43871, '127.0.0.1', () =>
  process.stdout.write('Batch workspace: http://127.0.0.1:43871\n'),
);
