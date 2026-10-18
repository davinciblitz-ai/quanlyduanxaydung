/* Local, offline-capable PDF/PNG export. HTML stays local to the browser. */
window.ReportExport=(()=>{
 let libraries=null;
 function load(){return libraries??=Promise.all(['vendor/html2canvas.min.js','vendor/jspdf.umd.min.js','vendor/jszip.min.js'].map(src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(Error('Không tải được thư viện xuất báo cáo.'));document.head.append(script);})));}
 function save(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
 function hasReportInk(canvas,top,height){const data=canvas.getContext('2d').getImageData(0,top,canvas.width,height).data;let rows=0;for(let y=1;y<height-1;y+=2){let count=0;for(let x=0;x<canvas.width;x+=3){const i=(y*canvas.width+x)*4;if(Math.min(data[i],data[i+1],data[i+2])<238&&++count>4)break;}if(count>4&&++rows>1)return true;}return false;}
 async function raster(sections){await load();await document.fonts.ready;const canvases=[];for(const section of sections){const rect=section.getBoundingClientRect();if(rect.height>24000)throw Error('Mục quá dài để xuất ảnh một lần. Chọn ít mục hơn hoặc dùng In.');const canvas=await html2canvas(section,{backgroundColor:'#ffffff',scale:1.35,logging:false,useCORS:false,allowTaint:false,windowWidth:1280,scrollX:0,scrollY:0});const scale=canvas.width/rect.width;canvas.reportBlocks=[...section.querySelectorAll('.panel,.kpi-grid,.gantt-row,tr,.report-network-tile,.report-title,.page-heading,.notice,.path-line')].map(el=>{const r=el.getBoundingClientRect();return {top:Math.max(0,(r.top-rect.top)*scale),bottom:(r.bottom-rect.top)*scale,height:r.height*scale};});canvases.push(canvas);}return canvases;}
 async function run(sections,format,name='bao-cao-du-an'){
  if(!sections.length)throw Error('Chọn ít nhất một mục.');
  if(format==='print'){const stage=sections[0].parentElement;stage.classList.add('native-print');const cleanup=()=>{stage.remove();document.body.classList.remove('report-printing');};document.body.classList.add('report-printing');window.addEventListener('afterprint',cleanup,{once:true});window.print();return {native:true};}
  const canvases=await raster(sections);
  if(format==='pdf'){
   const pdf=new jspdf.jsPDF({orientation:'landscape',unit:'mm',format:'a4'});let first=true;
   for(const canvas of canvases){const slice=Math.floor(canvas.width*190/277);let top=0;while(top<canvas.height){let bottom=Math.min(canvas.height,top+slice);if(bottom<canvas.height){const crosses=(canvas.reportBlocks||[]).filter(b=>b.top<bottom-1&&b.bottom>bottom+1&&b.height<slice*.93&&b.top>top+slice*.3);if(crosses.length)bottom=Math.floor(Math.min(...crosses.map(b=>b.top)));}if(canvas.height-bottom<20)bottom=canvas.height;const h=Math.max(1,bottom-top);if(!hasReportInk(canvas,top,h)){top=bottom;continue;}if(!first)pdf.addPage();first=false;const piece=document.createElement('canvas');piece.width=canvas.width;piece.height=h;piece.getContext('2d').drawImage(canvas,0,top,canvas.width,h,0,0,canvas.width,h);pdf.addImage(piece.toDataURL('image/png'),'PNG',10,10,277,h/canvas.width*277,undefined,'FAST');top=bottom;}}

   const pages=pdf.getNumberOfPages();for(let i=1;i<=pages;i++){pdf.setPage(i);pdf.setFontSize(8);pdf.setTextColor(90);pdf.text(i+' / '+pages,287,205,{align:'right'});}pdf.setProperties({title:name});save(name+'.pdf',pdf.output('blob'));return {pages};
  }
  if(format==='png'){
   if(canvases.length===1){save(name+'.png',await new Promise(resolve=>canvases[0].toBlob(resolve,'image/png')));return;}
   const zip=new JSZip();for(let i=0;i<canvases.length;i++){const blob=await new Promise(resolve=>canvases[i].toBlob(resolve,'image/png'));zip.file(String(i+1).padStart(2,'0')+'-'+(sections[i].dataset.reportLabel||'trang')+'.png',blob);}save(name+'-anh.zip',await zip.generateAsync({type:'blob'}));return;
  }
  if(format==='clipboard'){
   if(!navigator.clipboard?.write||!window.ClipboardItem)throw Error('Trình duyệt chưa hỗ trợ sao chép ảnh. Chọn Xuất ảnh để tải PNG.');const width=Math.max(...canvases.map(c=>c.width)),height=canvases.reduce((s,c)=>s+c.height+24,0);if(height>24000)throw Error('Ảnh quá dài để sao chép. Chọn ít mục hơn hoặc tải PDF.');const merged=document.createElement('canvas');merged.width=width;merged.height=height;const ctx=merged.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);let top=0;for(const canvas of canvases){ctx.drawImage(canvas,0,top);top+=canvas.height+24;}const blob=await new Promise(resolve=>merged.toBlob(resolve,'image/png'));if(!blob)throw Error('Không tạo được ảnh.');await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);return {copied:true};
  }
  throw Error('Định dạng xuất không hợp lệ.');
 }
 return {run};
})();
