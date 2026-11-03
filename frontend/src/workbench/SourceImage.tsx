import { useState } from 'react';
import type { VisualSource } from './visualTypes';
import { isMaterialPageImageUrl } from './diagramModel';

function localImageUrl(url:string){
  try{
    const parsed=new URL(url,window.location.origin);
    return parsed.origin===window.location.origin&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&isMaterialPageImageUrl(parsed.pathname)?parsed.href:'';
  }catch{return '';}
}

/** Crop the real page pixels only; citation matching does not certify what the picture means. */
export function SourceImage({url,title,crop}:{url?:string;title:string;crop?:VisualSource['crop']}){
  const [imageState,setImageState]=useState<{url:string;dimensions?:{width:number;height:number};failed:boolean}>({url:'',failed:false});
  const imageUrl=url?localImageUrl(url):'';
  const current=imageState.url===imageUrl?imageState:{url:imageUrl,failed:false};
  const dimensions=current.dimensions;
  const failed=current.failed;
  if(!imageUrl||failed)return <span className="visual-image-error">原页图像无法显示，可以点「打开原页」查看。</span>;
  const outside=crop&&dimensions&&(crop.x+crop.width>dimensions.width||crop.y+crop.height>dimensions.height);
  return <div className="visual-source-image">
    {!dimensions&&<span className="visual-image-loading" role="status">正在加载原页图像…</span>}
    <img src={imageUrl} alt={title} className={crop?'visual-crop-loader':undefined}
      onLoad={event=>setImageState({url:imageUrl,dimensions:{width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight},failed:false})} onError={()=>setImageState({url:imageUrl,failed:true})}/>
    {outside?<span className="visual-image-error">裁剪范围不在原页内，请打开原页核对。</span>:crop&&dimensions&&<svg viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`} role="img" aria-label={title} preserveAspectRatio="xMidYMid meet">
      <image href={imageUrl} width={dimensions.width} height={dimensions.height}/>
    </svg>}
  </div>;
}
