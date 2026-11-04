export type MinutesActionItem = {
  task: string;
  assignee: string | null;
  due: string | null;
};

export type MinutesDocumentData = {
  title: string;
  purpose?: string | null;
  status?: string | null;
  createdAt: number;
  scheduledFor?: number | null;
  endedAt?: number | null;
  summary: string;
  key_points?: string[];
  decisions?: string[];
  action_items?: MinutesActionItem[];
  summaryUpdatedAt?: number | null;
};

type ZipEntry = {
  name: string;
  data: Uint8Array;
  crc32: number;
  offset: number;
  modDate: number;
  modTime: number;
};

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const XML_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const textEncoder = new TextEncoder();

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\r/g, "");
}

function stripUrls(value: string) {
  return normalizeWhitespace(value).replace(URL_PATTERN, "").trim();
}

function stripMarkdown(value: string) {
  return stripUrls(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[>*_~]/g, "")
    .trim();
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function toParagraphs(summary: string) {
  return stripMarkdown(summary)
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
}

function toDisplayText(value: string | null | undefined, fallback = "Not specified") {
  const normalized = stripUrls(value ?? "");
  return normalized || fallback;
}

function getMeetingTimestamp(data: MinutesDocumentData) {
  return data.endedAt ?? data.scheduledFor ?? data.createdAt;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const modTime = (hours << 11) | (minutes << 5) | seconds;
  const modDate = ((year - 1980) << 9) | (month << 5) | day;

  return { modDate, modTime };
}

function crc32(data: Uint8Array) {
  let value = 0xffffffff;

  for (const byte of data) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function concatUint8Arrays(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function createZip(entries: Array<{ name: string; contents: string }>) {
  const now = new Date();
  const { modDate, modTime } = dosDateTime(now);

  const preparedEntries: ZipEntry[] = entries.map((entry) => ({
    name: entry.name,
    data: textEncoder.encode(entry.contents),
    crc32: 0,
    offset: 0,
    modDate,
    modTime,
  }));

  const localParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of preparedEntries) {
    const nameBytes = textEncoder.encode(entry.name);
    entry.crc32 = crc32(entry.data);
    entry.offset = offset;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);

    writeUint32(view, 0, 0x04034b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 0);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, entry.modTime);
    writeUint16(view, 12, entry.modDate);
    writeUint32(view, 14, entry.crc32);
    writeUint32(view, 18, entry.data.length);
    writeUint32(view, 22, entry.data.length);
    writeUint16(view, 26, nameBytes.length);
    writeUint16(view, 28, 0);
    header.set(nameBytes, 30);

    localParts.push(header, entry.data);
    offset += header.length + entry.data.length;
  }

  const centralParts: Uint8Array[] = [];
  let centralDirectorySize = 0;

  for (const entry of preparedEntries) {
    const nameBytes = textEncoder.encode(entry.name);
    const header = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(header.buffer);

    writeUint32(view, 0, 0x02014b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 20);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, 0);
    writeUint16(view, 12, entry.modTime);
    writeUint16(view, 14, entry.modDate);
    writeUint32(view, 16, entry.crc32);
    writeUint32(view, 20, entry.data.length);
    writeUint32(view, 24, entry.data.length);
    writeUint16(view, 28, nameBytes.length);
    writeUint16(view, 30, 0);
    writeUint16(view, 32, 0);
    writeUint16(view, 34, 0);
    writeUint16(view, 36, 0);
    writeUint32(view, 38, 0);
    writeUint32(view, 42, entry.offset);
    header.set(nameBytes, 46);

    centralParts.push(header);
    centralDirectorySize += header.length;
  }

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, preparedEntries.length);
  writeUint16(endView, 10, preparedEntries.length);
  writeUint32(endView, 12, centralDirectorySize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return concatUint8Arrays([
    ...localParts,
    ...centralParts,
    endRecord,
  ]);
}

function xmlText(text: string) {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function xmlRun(
  text: string,
  options?: {
    bold?: boolean;
    italic?: boolean;
    color?: string;
    size?: number;
    caps?: boolean;
  },
) {
  const properties: string[] = [];

  if (options?.bold) properties.push("<w:b/>");
  if (options?.italic) properties.push("<w:i/>");
  if (options?.caps) properties.push("<w:caps/>");
  if (options?.color) properties.push(`<w:color w:val="${options.color}"/>`);
  if (options?.size) properties.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);

  if (properties.length === 0) {
    return xmlText(text);
  }

  return `<w:r><w:rPr>${properties.join("")}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(
  text: string,
  options?: {
    align?: "left" | "center";
    spacingBefore?: number;
    spacingAfter?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    size?: number;
    caps?: boolean;
  },
) {
  const pPr: string[] = [];
  const spacingBefore = options?.spacingBefore ?? 0;
  const spacingAfter = options?.spacingAfter ?? 120;

  pPr.push(`<w:spacing w:before="${spacingBefore}" w:after="${spacingAfter}"/>`);

  if (options?.align) {
    pPr.push(`<w:jc w:val="${options.align}"/>`);
  }

  return `<w:p><w:pPr>${pPr.join("")}</w:pPr>${xmlRun(text, options)}</w:p>`;
}

function heading(text: string) {
  return paragraph(text, {
    bold: true,
    caps: true,
    color: "1F2937",
    size: 24,
    spacingBefore: 360,
    spacingAfter: 160,
  });
}

function bulletParagraph(text: string) {
  return `<w:p><w:pPr><w:spacing w:after="100"/><w:ind w:left="360" w:hanging="180"/></w:pPr>${xmlRun("• ", {
    bold: true,
    color: "1F2937",
  })}${xmlText(text)}</w:p>`;
}

function emptyParagraph(text: string) {
  return paragraph(text, {
    italic: true,
    color: "6B7280",
  });
}

function tableCell(paragraphs: string[], width: number, shaded = false) {
  const shading = shaded ? `<w:shd w:val="clear" w:fill="F3F4F6"/>` : "";
  return `
    <w:tc>
      <w:tcPr>
        <w:tcW w:w="${width}" w:type="dxa"/>
        ${shading}
      </w:tcPr>
      ${paragraphs.join("")}
    </w:tc>
  `;
}

function tableRow(cells: string[]) {
  return `<w:tr>${cells.join("")}</w:tr>`;
}

function buildMetaTable(data: MinutesDocumentData) {
  const meetingTimestamp = getMeetingTimestamp(data);
  const updatedTimestamp = data.summaryUpdatedAt ?? data.endedAt ?? data.createdAt;

  const rows = [
    tableRow([
      tableCell([
        paragraph("Meeting Date", {
          bold: true,
          caps: true,
          color: "6B7280",
          size: 18,
          spacingAfter: 40,
        }),
        paragraph(formatDate(meetingTimestamp), { spacingAfter: 40 }),
      ], 4500),
      tableCell([
        paragraph("Meeting Time", {
          bold: true,
          caps: true,
          color: "6B7280",
          size: 18,
          spacingAfter: 40,
        }),
        paragraph(formatTime(meetingTimestamp), { spacingAfter: 40 }),
      ], 4500),
    ]),
    tableRow([
      tableCell([
        paragraph("Minutes Updated", {
          bold: true,
          caps: true,
          color: "6B7280",
          size: 18,
          spacingAfter: 40,
        }),
        paragraph(formatDate(updatedTimestamp), { spacingAfter: 40 }),
      ], 4500),
      tableCell([
        paragraph("Purpose", {
          bold: true,
          caps: true,
          color: "6B7280",
          size: 18,
          spacingAfter: 40,
        }),
        paragraph(toDisplayText(data.purpose), { spacingAfter: 40 }),
      ], 4500),
    ]),
  ];

  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblLayout w:type="fixed"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:left w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:bottom w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:right w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:insideH w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:insideV w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="4500"/>
        <w:gridCol w:w="4500"/>
      </w:tblGrid>
      ${rows.join("")}
    </w:tbl>
  `;
}

function buildActionItemsTable(items: MinutesActionItem[]) {
  if (items.length === 0) {
    return emptyParagraph("No action items were captured for this meeting.");
  }

  const rows = [
    tableRow([
      tableCell([paragraph("Action Item", {
        bold: true,
        caps: true,
        color: "111827",
        size: 18,
        spacingAfter: 20,
      })], 4200, true),
      tableCell([paragraph("Owner", {
        bold: true,
        caps: true,
        color: "111827",
        size: 18,
        spacingAfter: 20,
      })], 2400, true),
      tableCell([paragraph("Due Date", {
        bold: true,
        caps: true,
        color: "111827",
        size: 18,
        spacingAfter: 20,
      })], 2400, true),
    ]),
    ...items.map((item) =>
      tableRow([
        tableCell([paragraph(toDisplayText(item.task, ""), { spacingAfter: 40 })], 4200),
        tableCell([paragraph(toDisplayText(item.assignee, "Unassigned"), { spacingAfter: 40 })], 2400),
        tableCell([paragraph(toDisplayText(item.due, "Not set"), { spacingAfter: 40 })], 2400),
      ]),
    ),
  ];

  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:left w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:bottom w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:right w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:insideH w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
          <w:insideV w:val="single" w:sz="8" w:space="0" w:color="D1D5DB"/>
        </w:tblBorders>
      </w:tblPr>
      ${rows.join("")}
    </w:tbl>
  `;
}

function buildDocumentXml(data: MinutesDocumentData) {
  const summaryParagraphs = toParagraphs(data.summary);
  const keyPoints = (data.key_points ?? []).map((item) => stripUrls(item)).filter(Boolean);
  const decisions = (data.decisions ?? []).map((item) => stripUrls(item)).filter(Boolean);
  const actionItems = (data.action_items ?? []).map((item) => ({
    task: stripUrls(item.task),
    assignee: item.assignee ? stripUrls(item.assignee) : null,
    due: item.due ? stripUrls(item.due) : null,
  }));

  const bodyParts = [
    paragraph("Professional Minutes of Meeting", {
      align: "center",
      bold: true,
      caps: true,
      color: "6B7280",
      size: 20,
      spacingAfter: 80,
    }),
    paragraph(data.title, {
      align: "center",
      bold: true,
      color: "111827",
      size: 34,
      spacingAfter: 80,
    }),
    paragraph(
      "Prepared for email sharing. Meeting access links and other non-essential joining details have been excluded.",
      {
        align: "center",
        color: "4B5563",
        size: 20,
        spacingAfter: 280,
      },
    ),
    buildMetaTable(data),
    heading("Executive Summary"),
    ...(summaryParagraphs.length > 0
      ? summaryParagraphs.map((item) => paragraph(item, { spacingAfter: 120 }))
      : [emptyParagraph("No executive summary is available for this meeting.")]),
    heading("Discussion Highlights"),
    ...(keyPoints.length > 0
      ? keyPoints.map((item) => bulletParagraph(item))
      : [emptyParagraph("No discussion highlights were captured for this meeting.")]),
    heading("Decisions"),
    ...(decisions.length > 0
      ? decisions.map((item) => bulletParagraph(item))
      : [emptyParagraph("No formal decisions were captured for this meeting.")]),
    heading("Action Items"),
    buildActionItemsTable(actionItems),
  ];

  return `${XML_HEADER}
<w:document xmlns:w="${WORD_NS}" xmlns:r="${DOC_REL_NS}">
  <w:body>
    ${bodyParts.join("")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function buildStylesXml() {
  return `${XML_HEADER}
<w:styles xmlns:w="${WORD_NS}">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos" w:cs="Aptos"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:lang w:val="en-US"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="360" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`;
}

function buildSettingsXml() {
  return `${XML_HEADER}
<w:settings xmlns:w="${WORD_NS}">
  <w:zoom w:percent="100"/>
  <w:defaultTabStop w:val="720"/>
  <w:compat/>
</w:settings>`;
}

function buildContentTypesXml() {
  return `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;
}

function buildRootRelationshipsXml() {
  return `${XML_HEADER}
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildDocumentRelationshipsXml() {
  return `${XML_HEADER}
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;
}

function buildCorePropertiesXml(data: MinutesDocumentData) {
  const timestamp = new Date(data.summaryUpdatedAt ?? Date.now()).toISOString();

  return `${XML_HEADER}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(data.title)}</dc:title>
  <dc:subject>Minutes of Meeting</dc:subject>
  <dc:creator>Meetup</dc:creator>
  <cp:keywords>meeting,minutes,summary</cp:keywords>
  <dc:description>${escapeXml(toDisplayText(data.purpose, "Professional meeting minutes"))}</dc:description>
  <cp:lastModifiedBy>Meetup</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`;
}

function buildAppPropertiesXml() {
  return `${XML_HEADER}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Meetup</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company>Meetup</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0</AppVersion>
</Properties>`;
}

export function getMinutesPreview(data: MinutesDocumentData) {
  const preview = stripMarkdown(data.summary).replace(/\s+/g, " ").trim();

  if (preview.length <= 220) {
    return preview;
  }

  return `${preview.slice(0, 217).trimEnd()}...`;
}

export function buildMinutesFilename(data: MinutesDocumentData) {
  const safeTitle = data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "meeting";

  return `${formatFileDate(getMeetingTimestamp(data))}-${safeTitle}-mom`;
}

export function buildMinutesDocumentDocx(data: MinutesDocumentData) {
  return createZip([
    {
      name: "[Content_Types].xml",
      contents: buildContentTypesXml(),
    },
    {
      name: "_rels/.rels",
      contents: buildRootRelationshipsXml(),
    },
    {
      name: "docProps/core.xml",
      contents: buildCorePropertiesXml(data),
    },
    {
      name: "docProps/app.xml",
      contents: buildAppPropertiesXml(),
    },
    {
      name: "word/document.xml",
      contents: buildDocumentXml(data),
    },
    {
      name: "word/styles.xml",
      contents: buildStylesXml(),
    },
    {
      name: "word/settings.xml",
      contents: buildSettingsXml(),
    },
    {
      name: "word/_rels/document.xml.rels",
      contents: buildDocumentRelationshipsXml(),
    },
  ]);
}

export function downloadMinutesDocument(data: MinutesDocumentData) {
  const docx = buildMinutesDocumentDocx(data);
  const fileName = `${buildMinutesFilename(data)}.docx`;
  const blob = new Blob([docx], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);

  return fileName;
}
