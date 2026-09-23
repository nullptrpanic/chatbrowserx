import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('targets the retry notice under tsx without selecting inert page buttons', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { runInNewContext } from 'node:vm';
       import { clickTranslationAction } from './e2e/tests/browser/helpers/translation-action.ts';
       const button = {hidden:false,getBoundingClientRect:()=>({x:10,y:20,width:80,height:30})};
       const pageButton = {hidden:false,getBoundingClientRect:()=>({x:300,y:400,width:100,height:40})};
       const isolated = {document:{querySelector:()=>({})},chrome:{dom:{openOrClosedShadowRoot:()=>({querySelector:(selector)=>selector==='.notice > button'?button:pageButton})}}};
       const browser = {chrome:{scripting:{executeScript:async ({target,func})=>{
         if(target.tabId!==7)throw new Error('Wrong target');
         return [{result:runInNewContext('('+func.toString()+')()',isolated)}];
       }}}};
       const panel = {evaluate:async (program,arg)=>runInNewContext(typeof program==='string'?program:'('+program.toString()+')('+JSON.stringify(arg)+')',browser)};
       const clicks=[];
       await clickTranslationAction({mouse:{click:async (x,y)=>clicks.push({x,y})}},panel,7);
       console.log(JSON.stringify(clicks));`,
    ],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(output.trim())).toEqual([{ x: 50, y: 35 }]);
});
