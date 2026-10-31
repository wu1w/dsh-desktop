const whitespace=/\s/;

// Resolve link endings once, backwards. Outside a parenthesized link group,
// whitespace is invalid; inside it, only another parenthesis or newline is
// invalid. This is the existing one-level link grammar without backtracking.
function linkIndex(text){
  if(!text.includes('[')||!text.includes(']('))return null;
  const endings=new Int32Array(text.length+1),brackets=[],newlines=[],angles=new Map();
  endings[text.length]=-1;let inner=-1,greater=-1;
  for(let i=text.length-1;i>=0;i--){
    const char=text[i],nextInner=inner;
    if(char===')'){endings[i]=i;inner=i;}
    else if(char==='('){endings[i]=nextInner<0?-1:endings[nextInner+1];inner=-1;}
    else{endings[i]=whitespace.test(char)?-1:endings[i+1];if(char==='\n')inner=-1;}
    if(char==='\n'){greater=-1;newlines.push(i);}
    else if(char==='>')greater=i;
    else if(char==='<'&&greater>i+1&&text[greater+1]===')')angles.set(i,greater+1);
    if(char===']')brackets.push(i);
  }
  brackets.reverse();newlines.reverse();return {endings,brackets,newlines,angles};
}

// Incomplete delimiters stay literal during streaming. No source text is
// truncated, evaluated as HTML, or reparsed by an unbounded link regexp.
export function markdownInline(value=''){
  const text=String(value),links=linkIndex(text),tokens=[];let index=0,plain=0,bracket=0,newline=0;
  const emit=(kind,end,contentStart,contentEnd,extra)=>{
    if(index>plain)tokens.push({kind:'text',text:text.slice(plain,index)});
    tokens.push({kind,text:text.slice(contentStart,contentEnd),...extra});index=end;plain=end;
  };
  while(index<text.length){
    const char=text[index];
    if(char==='`'){
      const end=text.indexOf('`',index+1);if(end>index+1){emit('code',end+1,index+1,end);continue;}
    }else if(char==='*'){
      if(text[index+1]==='*'){
        const end=text.indexOf('*',index+2);if(end>index+2&&text[end+1]==='*'){emit('bold',end+2,index+2,end);continue;}
      }
      const end=text.indexOf('*',index+1);if(end>index+1){emit('italic',end+1,index+1,end);continue;}
    }else if(char==='['&&links){
      while(links.brackets[bracket]<=index)bracket++;
      while(links.newlines[newline]<=index)newline++;
      const close=links.brackets[bracket],lineEnd=links.newlines[newline]??text.length,start=close+2;
      if(close>index+1&&close<lineEnd&&text[close+1]==='('&&start<text.length){
        const angle=links.angles.get(start),first=text[start];
        const end=angle??(!whitespace.test(first)&&first!=='('&&first!==')'?links.endings[start]:-1);
        if(end>=start){const target=text.slice(start,end);emit('link',end+1,index+1,close,{target:angle===undefined?target:target.slice(1,-1)});continue;}
      }
    }
    index++;
  }
  if(plain<text.length)tokens.push({kind:'text',text:text.slice(plain)});
  return tokens;
}
