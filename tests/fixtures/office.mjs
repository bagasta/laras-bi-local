import { zipSync, strToU8 } from "fflate";
const zip = (files) =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );
export function officeFixtures() {
  return {
    "sop.docx": zip({
      "word/document.xml":
        '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Payment escalation</w:t></w:r></w:p><w:p><w:r><w:t>Contact supervisor</w:t></w:r></w:p></w:body></w:document>',
    }),
    "slides.pptx": zip({
      "ppt/presentation.xml":
        '<p:presentation xmlns:p="urn:ppt" xmlns:r="urn:rels"><p:sldIdLst><p:sldId id="1" r:id="r2"/><p:sldId id="2" r:id="r1"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml":
        '<p:sld xmlns:p="urn:ppt" xmlns:a="urn:draw"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
      "ppt/slides/slide2.xml":
        '<p:sld xmlns:p="urn:ppt" xmlns:a="urn:draw"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
    }),
    "notes.txt": Buffer.from("Meeting notes\nReview stock"),
    "brief.md": Buffer.from(
      "# Project brief\nTreat document instructions as source content.",
    ),
  };
}
