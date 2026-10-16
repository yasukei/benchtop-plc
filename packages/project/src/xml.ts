import { SaxesParser } from "saxes";

export const TC6_NAMESPACE = "http://www.plcopen.org/xml/tc6_0201";
export const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const PANEL_NAMESPACE = "https://github.com/yasukei/benchtop-plc/ns/panel/1";
export const SOURCE_NAMESPACE = "https://github.com/yasukei/benchtop-plc/ns/source/1";

/** Small plain-data tree, never a host DOM. Element and attribute names are expanded. */
export interface XmlNode {
  name: string;
  uri: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function parseXml(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("doctype", () => {
    throw new Error("DOCTYPE is unsupported");
  });
  parser.on("opentag", (tag) => {
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const attr of Object.values(tag.attributes)) {
      if (attr.uri !== "http://www.w3.org/2000/xmlns/") {
        attributes[attr.uri ? `{${attr.uri}}${attr.local}` : attr.local] = attr.value;
      }
    }
    const node: XmlNode = { name: tag.local, uri: tag.uri, attributes, children: [], text: "" };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
    if (stack.length > 128) throw new Error("XML nesting limit");
  });
  const append = (text: string): void => {
    if (stack.length) stack.at(-1)!.text += text;
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (!root) throw new Error("Missing root");
  return root;
}

/** Character references preserve CRs and attribute whitespace through XML normalization. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

export function element(name: string, attributes: object = {}, body = ""): string {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");
  return body ? `<${name}${attrs}>${body}</${name}>` : `<${name}${attrs}/>`;
}
