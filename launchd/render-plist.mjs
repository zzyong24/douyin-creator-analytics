import {readFileSync} from 'node:fs';
import {MODULE_DIR,ROOT,expectedNickname,AppError} from '../src/runtime.mjs';
import {EGO_USER_DATA_DIR,EGO_EXECUTABLE} from '../src/ego.mjs';
export function renderPlist({label=process.env.DOUYIN_ANALYTICS_LABEL||'com.douyin-analytics',moduleDir=MODULE_DIR,home=ROOT,nickname=expectedNickname(),nodeBin=process.env.ANALYTICS_NODE_BIN||process.execPath,egoDir=EGO_USER_DATA_DIR,egoExecutable=EGO_EXECUTABLE}={}){
 if(!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label))throw new AppError('LAUNCHD_LABEL_INVALID');
 if(!nickname?.trim())throw new AppError('EXPECTED_NICKNAME_REQUIRED');
 if([moduleDir,home,nodeBin,egoDir,egoExecutable].some(v=>!v.startsWith('/')))throw new AppError('LAUNCHD_PATH_MUST_BE_ABSOLUTE');
 const escape=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
 const values={LABEL:label,MODULE_DIR:moduleDir,RUNTIME_HOME:home,EXPECTED_NICKNAME:nickname.trim(),NODE_BIN:nodeBin,EGO_USER_DATA_DIR:egoDir,EGO_EXECUTABLE:egoExecutable};
 return readFileSync(new URL('./com.example.douyin-analytics.plist.template',import.meta.url),'utf8').replace(/__([A-Z_]+)__/g,(_,key)=>escape(values[key]));
}
