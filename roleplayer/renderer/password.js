"use strict";
/* The admin password is stored only as this hash. Used by the program and by the installer editor. */
const hashPassword = password => sha256("roleplayer-v1:" + password);
function sha256(str){
  const K=[],H=[];let n=2,i=0;const frac=x=>((x-Math.floor(x))*4294967296)|0;
  while(i<64){let p=true;for(let d=2;d*d<=n;d++)if(n%d===0){p=false;break;}
    if(p){if(i<8)H[i]=frac(Math.pow(n,1/2));K[i++]=frac(Math.pow(n,1/3));}n++;}
  const b=Array.from(new TextEncoder().encode(str));const l=b.length*8;
  b.push(0x80);while(b.length%64!==56)b.push(0);
  for(let j=7;j>=0;j--)b.push(j>3?0:(l>>>(j*8))&255);
  const w=new Array(64),rr=(x,k)=>(x>>>k)|(x<<(32-k));
  for(let o=0;o<b.length;o+=64){
    for(let j=0;j<16;j++)w[j]=(b[o+4*j]<<24)|(b[o+4*j+1]<<16)|(b[o+4*j+2]<<8)|b[o+4*j+3];
    for(let j=16;j<64;j++){const s0=rr(w[j-15],7)^rr(w[j-15],18)^(w[j-15]>>>3),s1=rr(w[j-2],17)^rr(w[j-2],19)^(w[j-2]>>>10);w[j]=(w[j-16]+s0+w[j-7]+s1)|0;}
    let [a,bb,c,d,e,f,g,h]=H;
    for(let j=0;j<64;j++){const S1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^(~e&g),t1=(h+S1+ch+K[j]+w[j])|0,S0=rr(a,2)^rr(a,13)^rr(a,22),mj=(a&bb)^(a&c)^(bb&c),t2=(S0+mj)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=bb;bb=a;a=(t1+t2)|0;}
    [a,bb,c,d,e,f,g,h].forEach((v,j)=>H[j]=(H[j]+v)|0);
  }
  return H.map(x=>(x>>>0).toString(16).padStart(8,"0")).join("");
}
