import {describe,expect,it} from "vitest";
import {createArchive,validatePortableRootName} from "../src/lib/archive";
import {encodeLargeTreeMetadata,parseLargeTreeMetadata} from "../src/lib/large-transfer";
import {collectSelectedFiles} from "../src/lib/selected-files";

// Microsoft Win32 naming rules reserve these six exact device basenames,
// including mixed case and extensions. Other superscript digits are not listed.
const devices=["COM¹","COM²","COM³","LPT¹","LPT²","LPT³"];
const file=(path:string)=>({path,size:0,lastModified:1,sha256Hex:"0".repeat(64)});
const metadata=(path:string)=>({rootName:"fixture",directories:["nested"],files:[file(path)]});
const handle=(name:string)=>({kind:"file",name,async getFile(){return new File([],name,{lastModified:1});}} as FileSystemFileHandle);

describe("Windows superscript device-name portability",()=>{
  it.each(devices)("rejects archive entry %s and its extended spelling",name=>{
    for(const candidate of [name,name.toLowerCase()+".tar.gz"]){
      expect(()=>createArchive([{path:`nested/${candidate}`,bytes:new Uint8Array()}])).toThrow(/representable/);
    }
  });
  it.each(devices)("rejects root folder %s",name=>{
    expect(()=>validatePortableRootName(name)).toThrow(/representable/);
  });
  it.each(devices)("rejects outgoing tree file and directory %s",name=>{
    expect(()=>encodeLargeTreeMetadata(metadata(`nested/${name}.txt`))).toThrow(/portable/);
    expect(()=>encodeLargeTreeMetadata({rootName:"fixture",directories:[name],files:[]})).toThrow(/portable/);
  });
  it.each(devices)("rejects incoming tree metadata containing %s",name=>{
    // Build a valid wire envelope first, then independently substitute the
    // hostile path. The receiving parser must not rely on its own encoder.
    const valid=new TextDecoder().decode(encodeLargeTreeMetadata(metadata("nested/ordinary.txt")));
    const hostile=valid.replace("nested/ordinary.txt",`nested/${name}.txt`);
    expect(()=>parseLargeTreeMetadata(new TextEncoder().encode(hostile))).toThrow(/portable/);
  });
  it.each(devices)("rejects selected file %s before preparation",async name=>{
    await expect(collectSelectedFiles([handle(name+".txt")])).rejects.toThrow(/portable/);
  });
  it.each(["COM⁴.txt","LPT⁴","COM10.bin","LPT0","xCOM¹","COM¹more"])("retains legal neighboring name %s exactly",async name=>{
    expect(validatePortableRootName(name)).toBe(name);
    expect(()=>createArchive([{path:name,bytes:new Uint8Array()}])).not.toThrow();
    const decoded=parseLargeTreeMetadata(encodeLargeTreeMetadata(metadata(`nested/${name}`)));
    expect(decoded.files[0].path).toBe(`nested/${name}`);
    const selected=await collectSelectedFiles([handle(name)]);
    expect(selected.files.map(entry=>entry.path)).toEqual([name]);
  });
});
