const status=document.getElementById('startup-status');
const retry=document.getElementById('retry');
const diagnostics=document.getElementById('diagnostics');
function update(state){status.textContent=state.message || 'Starting the review engine…';retry.hidden=state.status!=='error';diagnostics.hidden=state.status!=='error';}
window.desktop.onRuntime(update);
window.desktop.runtimeStatus().then(update);
retry.addEventListener('click',()=>{retry.hidden=true;window.desktop.retry().catch(()=>update({status:'error',message:'Unable to restart. Quit and reopen the application.'}));});
diagnostics.addEventListener('click',()=>window.desktop.showDiagnostics());
