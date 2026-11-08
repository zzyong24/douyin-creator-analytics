"""仅本机CSV/XLSX解析；输出给父进程内存，不在CLI打印表内容。"""
import csv, io, json, sys, zipfile, re, datetime
import xml.etree.ElementTree as ET
from pathlib import Path
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def read(path):
    data=Path(path).read_bytes()
    if len(data)>80*1024*1024: raise ValueError('EXPORT_TOO_LARGE')
    if not data.startswith(b'PK'):
        text=None
        for enc in ('utf-8-sig','utf-16','gb18030'):
            try:
                candidate=data.decode(enc)
                if '\x00' not in candidate: text=candidate; break
            except UnicodeError: pass
        if text is None: raise ValueError('EXPORT_ENCODING_UNKNOWN')
        try: dialect=csv.Sniffer().sniff(text[:20000],delimiters=',\t;')
        except csv.Error: dialect=csv.excel
        return {'format':'CSV','sheets':[{'name':'CSV','rows':list(csv.reader(io.StringIO(text),dialect))}]}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if sum(i.file_size for i in z.infolist())>160*1024*1024: raise ValueError('EXPORT_ZIP_TOO_LARGE')
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',NS): shared.append(''.join(si.itertext()))
        date_styles=set(); percent_styles=set()
        if 'xl/styles.xml' in z.namelist():
            styles=ET.fromstring(z.read('xl/styles.xml'))
            custom={int(n.attrib['numFmtId']):n.attrib.get('formatCode','') for n in styles.findall('m:numFmts/m:numFmt',NS)}
            for i,n in enumerate(styles.findall('m:cellXfs/m:xf',NS)):
                fmt=int(n.attrib.get('numFmtId','0'))
                if fmt in (9,10) or '%' in custom.get(fmt,''): percent_styles.add(i)
                if fmt in (14,15,16,17,18,19,20,21,22,45,46,47) or re.search(r'[ydh]|ss',custom.get(fmt,''),re.I): date_styles.add(i)
        workbook=ET.fromstring(z.read('xl/workbook.xml'))
        epoch=datetime.datetime(1904,1,1) if workbook.find('m:workbookPr',NS) is not None and workbook.find('m:workbookPr',NS).attrib.get('date1904') in ('1','true') else datetime.datetime(1899,12,30)
        rels={r.attrib['Id']:r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        result=[]
        for sheet in workbook.findall('m:sheets/m:sheet',NS):
            rid=sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']; target=rels[rid]
            target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
            if '..' in target.split('/'): raise ValueError('EXPORT_BAD_PATH')
            rows=[]
            for r in ET.fromstring(z.read(target)).findall('m:sheetData/m:row',NS):
                values=[]
                for c in r.findall('m:c',NS):
                    col=re.match('[A-Z]+',c.attrib.get('r','A'))[0]; index=0
                    for a in col: index=index*26+ord(a)-64
                    while len(values)<index: values.append('')
                    typ=c.attrib.get('t'); v=c.find('m:v',NS); value=v.text if v is not None and v.text is not None else ''
                    if typ=='s': value=shared[int(value)]
                    elif typ=='inlineStr': value=''.join(c.find('m:is',NS).itertext())
                    # 日期样式是显式格式证据；保留原Excel序列，另附格式化显示。
                    if value and typ not in ('s','inlineStr','str') and int(c.attrib.get('s','0')) in date_styles:
                        value={'raw':value,'display':(epoch+datetime.timedelta(days=float(value))).isoformat(sep=' '),'kind':'excel_date'}
                    if value and typ not in ('s','inlineStr','str') and int(c.attrib.get('s','0')) in percent_styles:
                        value={'raw':value,'display':value,'unit':'比例','kind':'excel_percent'}
                    values[index-1]=value
                rows.append(values)
            result.append({'name':sheet.attrib['name'],'rows':rows})
        return {'format':'XLSX','sheets':result}
if __name__=='__main__':
    try: print(json.dumps(read(sys.argv[1]),ensure_ascii=False))
    except Exception: print(json.dumps({'error':'EXPORT_FILE_PARSE_FAILED'})); sys.exit(1)
