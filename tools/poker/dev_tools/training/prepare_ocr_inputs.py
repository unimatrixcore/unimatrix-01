#!/usr/bin/env python3
"""Deterministic region-aware image controls, independent of target text.

Never edits collector crops. Every original row is retained. Profile metadata
records transformed dimensions; unchanged examples are linked into the bundle.
"""
import argparse,hashlib,json,os
from pathlib import Path
import cv2
import numpy as np


def localize_pill(image,category,clean_status=True,status_text_filter=True):
    height,width=image.shape[:2]
    if category=='status':
        hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
        center=image[height//5:max(height//5+1,height*4//5),width//4:max(width//4+1,width*3//4)]
        colors,counts=np.unique((center.reshape(-1,3)//8)*8,axis=0,return_counts=True)
        masks=[]
        for index in np.argsort(counts)[-12:]:
            color=colors[index].astype(np.int16)
            if color.max()<100 or color.max()-color.min()<65:continue
            mask=(np.max(np.abs(image.astype(np.int16)-color),axis=2)<=16).astype(np.uint8)
            masks.append(mask)
    elif category=='bet':
        b,g,r=cv2.split(image)
        masks=[((r.astype(int)<65)&(g.astype(int)<85)&(b.astype(int)<110)&(g.astype(int)-r.astype(int)>5)&(b.astype(int)-r.astype(int)>10)).astype(np.uint8)]
    else:return image,None
    candidates=[]
    for mask in masks:
        count,labels,stats,centers=cv2.connectedComponentsWithStats(mask,8)
        for index in range(1,count):
            x,y,w,h,area=map(int,stats[index])
            if w<22 or h<12 or area<80 or area/(w*h)<.3:continue
            borders=int(x==0)+int(x+w==width)+int(y==0)+int(y+h==height)
            if category=='status':
                if not (x<=width/2<=x+w and y<=height/2<=y+h):continue
                vertical_edges=int(y==0)+int(y+h==height)
                score=area*(.1 if vertical_edges==2 else .5 if vertical_edges==1 else 1)
            else:score=area*(.05 if borders>=3 else 1)
            candidates.append((score,(max(0,x-2),max(0,y-2),min(width,x+w+2),min(height,y+h+2)),(labels==index).astype(np.uint8)))
    if not candidates:return image,None
    score,box,component=max(candidates,key=lambda item:item[0])
    x1,y1,x2,y2=box
    if category=='status' and clean_status:
        # Text lies inside the colored button. Fill its rounded exterior with
        # button color so neighboring white artwork cannot become parentheses.
        ys,xs=np.nonzero(component)
        hull=cv2.convexHull(np.column_stack((xs,ys)).astype(np.int32))
        inside=np.zeros((height,width),np.uint8);cv2.fillConvexPoly(inside,hull,1)
        inside=cv2.erode(inside,np.ones((3,3),np.uint8))
        background=np.median(image[component.astype(bool)],axis=0).astype(np.float32)
        # Selected saturated buttons have black text. Keep its antialiased
        # black/background mixtures; nearby cyan/pink card artwork is neither.
        pixels=image.astype(np.float32)
        alpha=np.clip(np.sum((background-pixels)*background,axis=2)/max(1,float(np.sum(background*background))),0,1)
        residual=np.linalg.norm(pixels-background*(1-alpha[:,:,None]),axis=2)
        image=image.copy();image[(inside==0)|((residual>22) if status_text_filter else False)]=background.astype(np.uint8)
        return image[y1:y2,x1:x2],box
    if (x2-x1)*(y2-y1)>=width*height*.97:return image,None
    return image[y1:y2,x1:x2],box


def normalize_name(image,letter_gap=0,remove_all_border=True):
    # UI text is a fixed gray blended against normal/turn/urgent plate colors.
    # Recover that foreground alpha instead of thresholding away faint i dots.
    green=(image[3:-3,:,1].astype(int)>160)&(image[3:-3,:,1].astype(int)>image[3:-3,:,0].astype(int)*1.7)&(image[3:-3,:,1].astype(int)>image[3:-3,:,2].astype(int)*1.7)
    if np.count_nonzero(green)>12:return image,None
    colors=[(53,42,25),(242,0,137),(94,62,225)]  # BGR, from collector colors.json
    foreground=np.array((200,177,168),dtype=np.float32)
    pixels=image.astype(np.float32);alpha=np.zeros(image.shape[:2],np.float32)
    for color in colors:
        background=np.array(color,dtype=np.float32);direction=foreground-background
        strength=np.clip(np.sum((pixels-background)*direction,axis=2)/np.sum(direction*direction),0,1)
        residual=np.linalg.norm(pixels-(background+strength[:,:,None]*direction),axis=2)
        alpha=np.maximum(alpha,np.where(residual<=22,strength,0))
    alpha[:3]=0;alpha[-3:]=0;alpha[alpha<.12]=0
    count,labels,stats,_=cv2.connectedComponentsWithStats((alpha>.12).astype(np.uint8),8)
    for index in range(1,count):
        x,y,w,h,area=map(int,stats[index])
        # Rounded plate corners touch the image boundary; centered username
        # glyphs do not. Their antialiasing otherwise resembles a stray 7/U.
        if (x==0 or x+w==image.shape[1]) and (remove_all_border or y+h<image.shape[0]*.35):alpha[labels==index]=0
    if np.count_nonzero(alpha>.5)<12:return image,None
    # Preserve anti-aliased coverage as gray; neither text nor labels are read.
    gray=np.clip((1-alpha)*255,0,255).astype(np.uint8)
    if letter_gap:
        occupied=np.any(alpha>.4,axis=0)
        boundaries=[x for x in range(1,len(occupied)) if occupied[x-1] and not occupied[x] and np.any(occupied[x+1:])]
        if 1<len(boundaries)<40:
            pieces=[];previous=0
            for boundary in boundaries:
                pieces.extend([gray[:,previous:boundary],np.full((gray.shape[0],letter_gap),255,np.uint8)]);previous=boundary
            pieces.append(gray[:,previous:]);gray=np.concatenate(pieces,axis=1)
    return cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR),{'foreground':'gray UI text alpha from configured plate colors','letter_gap':letter_gap}


def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',type=Path,required=True);p.add_argument('--image-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--name-scale',type=float,default=1);p.add_argument('--localize-pills',action='store_true');p.add_argument('--normalize-names',action='store_true');p.add_argument('--letter-gap',type=int,default=0);p.add_argument('--profile',choices=['runtime','v4-training','v5-training'],default='runtime');a=p.parse_args()
    rows=[json.loads(l) for l in a.manifest.read_text().splitlines()];a.output.mkdir(parents=True,exist_ok=True);audit=[]
    for row in rows:
        source=(a.image_root/row['image_path']).resolve();destination=a.output/row['image_path'];destination.parent.mkdir(parents=True,exist_ok=True)
        image=cv2.imread(str(source));assert image is not None
        old_shape=list(image.shape[:2]);box=None;normalization=None
        if a.localize_pills:image,box=localize_pill(image,row['category'],a.profile!='v4-training',a.profile=='runtime')
        if row['category']=='name' and a.normalize_names:image,normalization=normalize_name(image,a.letter_gap,a.profile!='v4-training')
        if row['category']=='name' and a.name_scale!=1:image=cv2.resize(image,(round(image.shape[1]*a.name_scale),image.shape[0]),interpolation=cv2.INTER_CUBIC)
        changed=box is not None or normalization is not None or (row['category']=='name' and a.name_scale!=1)
        if destination.exists() or destination.is_symlink():destination.unlink()
        if changed:assert cv2.imwrite(str(destination),image)
        else:destination.symlink_to(source)
        audit.append({'sample_id':row['sample_id'],'category':row['category'],'source_shape':old_shape,'output_shape':list(image.shape[:2]),'pill_box':box,'normalization':normalization,'transformed':changed})
    config={'profile':a.profile,'preprocessor_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'name_horizontal_scale':a.name_scale,'localize_pills':a.localize_pills,'normalize_names':a.normalize_names,'letter_gap':a.letter_gap,'target_text_used':False,'original_manifest_sha256':hashlib.sha256(a.manifest.read_bytes()).hexdigest(),'rows':audit}
    (a.output/'profile.json').write_text(json.dumps(config,indent=2)+'\n');print('Prepared',len(rows),'rows;',sum(r['transformed'] for r in audit),'transformed')

if __name__=='__main__':main()
