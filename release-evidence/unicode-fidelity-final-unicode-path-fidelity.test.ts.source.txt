import {describe,expect,it} from "vitest";
import {createArchive,extractArchive} from "../src/lib/archive";
import {collectSelectedFiles} from "../src/lib/selected-files";
import {prepareLargeSource,createLargeTreeReader,readLargeTreeManifest} from "../src/lib/large-transfer";

// Native C:/D: probes with case sensitivity disabled kept these pairs distinct.
// Full uppercase/case-fold expansion would incorrectly merge some of them.
const distinctPairs=[["σ","ς"],["i","ı"],["s","ſ"],["μ","µ"],["ss","ß"],["ff","ﬀ"]];

describe("Unicode path fidelity without full case-fold expansion",()=>{
  it.each(distinctPairs)("preserves distinct %s and %s through archive and large-source metadata",async(first,second)=>{
    const expected=new Map([[first,Uint8Array.of(17,19)],[second,Uint8Array.of(63,67,71)]]);
    const archive=createArchive([...expected].map(([path,bytes])=>({path,bytes})));
    const extracted=extractArchive(archive);
    expect(extracted).toHaveLength(2);
    for(const entry of extracted){expect(expected.has(entry.path)).toBe(true);expect(entry.bytes).toEqual(expected.get(entry.path));}
    const handles=[...expected].map(([name,bytes])=>({kind:"file",name,
      async getFile(){return new File([Uint8Array.from(bytes)],name,{lastModified:7});},
    } as FileSystemFileHandle));
    const selection=await collectSelectedFiles(handles);
    const prepared=await prepareLargeSource(selection);
    const reader=createLargeTreeReader(prepared);
    const tree=await readLargeTreeManifest(reader);
    expect(tree.files).toHaveLength(2);
    expect(new Set(tree.files.map(file=>file.path))).toEqual(new Set(expected.keys()));
    for(const file of tree.files){
      expect(file.size).toBe(BigInt(expected.get(file.path)!.length));
      expect(await reader.read(file.offset,Number(file.size))).toEqual(expected.get(file.path));
    }
  });
  it.each([["case","CASE"],["σ","Σ"],["μ","Μ"]])("rejects native case alias %s and %s",async(first,second)=>{
    expect(()=>createArchive([{path:first,bytes:Uint8Array.of(17)},{path:second,bytes:Uint8Array.of(63)}])).toThrow(/collide/);
    const handles=[first,second].map(name=>({kind:"file",name,getFile:async()=>new File([name],name,{lastModified:7})} as FileSystemFileHandle));
    await expect(collectSelectedFiles(handles)).rejects.toThrow(/collide/);
  });
});
