"""Extract title, author and chapters from EPUB and PDF files."""

import posixpath
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

import lxml.html
import pypdfium2 as pdfium
from lxml import etree

from .text import clean

MIN_CHAPTER_CHARS = 50
PDF_PAGES_PER_CHUNK = 10  # fallback chapter size for PDFs without an outline


class ExtractError(Exception):
    """Unsupported or unreadable input; the message is shown to the user."""


@dataclass
class Chapter:
    title: str
    text: str


@dataclass
class Book:
    title: str
    author: str
    chapters: list[Chapter] = field(default_factory=list)


def extract(path: str | Path) -> Book:
    path = Path(path)
    with open(path, "rb") as f:
        magic = f.read(5)
    if magic.startswith(b"%PDF"):
        book = extract_pdf(path)
    elif magic.startswith(b"PK"):
        book = extract_epub(path)
    else:
        raise ExtractError("Unsupported file type. Upload a PDF or EPUB.")
    if not book.chapters:
        raise ExtractError("No readable text was found in this book.")
    return book


# ---------------------------------------------------------------- EPUB

NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
    "enc": "http://www.w3.org/2001/04/xmlenc#",
}
# Font obfuscation algorithms: these appear in encryption.xml of DRM-free books.
FONT_OBFUSCATION = {
    "http://www.idpf.org/2008/embedding",
    "http://ns.adobe.com/pdf/enc#RC",
}
BLOCK_TAGS = {
    "p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
    "section", "article", "tr", "pre", "dd", "dt", "figcaption", "hr",
}


def _xml(zf: zipfile.ZipFile, name: str) -> etree._Element:
    parser = etree.XMLParser(recover=True, resolve_entities=False, no_network=True)
    return etree.fromstring(zf.read(name), parser)


def _resolve(base_dir: str, href: str) -> str:
    href = unquote(href.split("#", 1)[0])
    return posixpath.normpath(posixpath.join(base_dir, href))


def _check_drm(zf: zipfile.ZipFile) -> None:
    names = set(zf.namelist())
    if "META-INF/rights.xml" in names:
        raise ExtractError("This EPUB is DRM-protected and can't be read.")
    if "META-INF/encryption.xml" in names:
        root = _xml(zf, "META-INF/encryption.xml")
        algorithms = root.xpath("//enc:EncryptionMethod/@Algorithm", namespaces=NS)
        if any(a not in FONT_OBFUSCATION for a in algorithms):
            raise ExtractError("This EPUB is DRM-protected and can't be read.")


def _html_text(data: bytes) -> str:
    try:
        doc = lxml.html.document_fromstring(data)
    except (etree.ParserError, ValueError):
        return ""
    for bad in doc.xpath("//script|//style|//head|//sup[a]"):
        bad.drop_tree()
    for el in doc.iter():
        if isinstance(el.tag, str) and el.tag.lower() in BLOCK_TAGS:
            el.tail = "\n\n" + (el.tail or "")
    return clean(doc.text_content())


def _toc_titles(zf: zipfile.ZipFile, opf: etree._Element, opf_dir: str) -> dict[str, str]:
    """Map document path -> first TOC title pointing into it."""
    titles: dict[str, str] = {}
    nav = opf.xpath(
        "//opf:manifest/opf:item[contains(concat(' ', @properties, ' '), ' nav ')]/@href",
        namespaces=NS,
    )
    if nav:
        nav_path = _resolve(opf_dir, nav[0])
        doc = lxml.html.document_fromstring(zf.read(nav_path))
        nav_dir = posixpath.dirname(nav_path)
        tocs = [n for n in doc.iter("nav") if "toc" in (n.get("epub:type") or n.get("{%s}type" % NS["epub"]) or "")]
        for a in (tocs[0] if tocs else doc).iter("a"):
            if a.get("href"):
                titles.setdefault(_resolve(nav_dir, a.get("href")), " ".join(a.text_content().split()))
        if titles:
            return titles

    ncx_id = opf.xpath("//opf:spine/@toc", namespaces=NS)
    ncx_href = (
        opf.xpath(f"//opf:manifest/opf:item[@id='{ncx_id[0]}']/@href", namespaces=NS)
        if ncx_id
        else opf.xpath("//opf:manifest/opf:item[@media-type='application/x-dtbncx+xml']/@href", namespaces=NS)
    )
    if ncx_href:
        ncx_path = _resolve(opf_dir, ncx_href[0])
        ncx = _xml(zf, ncx_path)
        ncx_dir = posixpath.dirname(ncx_path)
        for point in ncx.iter("{%s}navPoint" % NS["ncx"]):
            label = point.xpath("string(ncx:navLabel/ncx:text)", namespaces=NS)
            src = point.xpath("string(ncx:content/@src)", namespaces=NS)
            if src:
                titles.setdefault(_resolve(ncx_dir, src), " ".join(label.split()))
    return titles


def extract_epub(path: Path) -> Book:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise ExtractError("This file is not a valid EPUB.") from e
    with zf:
        if "META-INF/container.xml" not in zf.namelist():
            raise ExtractError("Unsupported file type. Upload a PDF or EPUB.")
        _check_drm(zf)

        container = _xml(zf, "META-INF/container.xml")
        opf_path = container.xpath("string(//c:rootfile/@full-path)", namespaces=NS)
        opf = _xml(zf, opf_path)
        opf_dir = posixpath.dirname(opf_path)

        title = " ".join(opf.xpath("string(//dc:title)", namespaces=NS).split()) or path.stem
        author = " ".join(opf.xpath("string(//dc:creator)", namespaces=NS).split())

        manifest = {
            item.get("id"): _resolve(opf_dir, item.get("href"))
            for item in opf.xpath("//opf:manifest/opf:item", namespaces=NS)
        }
        spine = [
            manifest[ref.get("idref")]
            for ref in opf.xpath("//opf:spine/opf:itemref", namespaces=NS)
            if ref.get("linear") != "no" and ref.get("idref") in manifest
        ]
        toc = _toc_titles(zf, opf, opf_dir)

        # Each spine document with a TOC entry starts a chapter; untitled
        # documents are appended to the previous chapter.
        chapters: list[Chapter] = []
        for doc_path in spine:
            try:
                text = _html_text(zf.read(doc_path))
            except KeyError:
                continue
            if doc_path in toc or not chapters:
                chapters.append(Chapter(toc.get(doc_path) or f"Section {len(chapters) + 1}", text))
            elif text:
                chapters[-1].text = f"{chapters[-1].text}\n\n{text}".strip()

    chapters = [c for c in chapters if len(c.text) >= MIN_CHAPTER_CHARS]
    return Book(title, author, chapters)


# ---------------------------------------------------------------- PDF

_PAGE_NUMBER = re.compile(
    r"^\s*(page\s*)?(\d+|[ivxlcdm]+)(\s*(of|/)\s*\d+)?\s*$", re.IGNORECASE
)
EDGE_LINES = 2  # lines at the top/bottom of each page checked for headers/footers


def _edge_key(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip().lower())


def _strip_headers_footers(pages: list[list[str]]) -> list[str]:
    """Remove page numbers and lines repeated at the top/bottom of many pages."""
    counts: Counter[str] = Counter()
    for lines in pages:
        edges = lines[:EDGE_LINES] + lines[-EDGE_LINES:]
        counts.update({_edge_key(l) for l in edges if l.strip()})
    threshold = max(3, len(pages) * 0.3)
    repeated = {k for k, n in counts.items() if n >= threshold}

    result = []
    for lines in pages:
        n = len(lines)
        kept = [
            line
            for i, line in enumerate(lines)
            if not (
                (i < EDGE_LINES or i >= n - EDGE_LINES)
                and (_PAGE_NUMBER.match(line) or _edge_key(line) in repeated)
            )
        ]
        result.append("\n".join(kept))
    return result


def _outline_starts(pdf: pdfium.PdfDocument) -> list[tuple[int, str]]:
    """(page_index, title) for chapters from the outline, using the shallowest
    level that has at least two entries."""
    items = []
    for bm in pdf.get_toc():
        dest = bm.get_dest()
        page = dest.get_index() if dest else None
        if page is not None:
            items.append((bm.level, page, " ".join((bm.get_title() or "").split())))
    for level in sorted({lvl for lvl, _, _ in items}):
        # Stable sort keeps outline order for entries on the same page.
        starts = sorted(((p, t) for lvl, p, t in items if lvl == level), key=lambda x: x[0])
        if len(starts) >= 2:
            return starts
    return []


def _find_heading(full: str, title: str, lo: int, hi: int) -> int:
    """Offset of `title` within full[lo:hi], preferring a match at a line start
    (optionally after a section number). Returns `lo` if not found."""
    words = re.findall(r"\w+", title)
    if not words:
        return lo
    body = r"\W*".join(re.escape(w) for w in words)
    for pattern in (rf"(?im)^[\d.\sIVXivx]*{body}", rf"(?i){body}"):
        m = re.compile(pattern).search(full, lo, hi)
        if m:
            return m.start()
    return lo


def extract_pdf(path: Path) -> Book:
    try:
        pdf = pdfium.PdfDocument(path)
    except pdfium.PdfiumError as e:
        raise ExtractError("This PDF can't be opened (it may be password-protected or damaged).") from e
    try:
        meta = pdf.get_metadata_dict()
        title = (meta.get("Title") or "").strip() or path.stem
        author = (meta.get("Author") or "").strip()

        raw_pages = []
        for i in range(len(pdf)):
            page = pdf[i]
            textpage = page.get_textpage()
            raw_pages.append(textpage.get_text_bounded().replace("\r\n", "\n").split("\n"))
            textpage.close()
            page.close()

        total_chars = sum(len("".join(lines).strip()) for lines in raw_pages)
        if total_chars < 100 * max(1, len(raw_pages)) * 0.2:
            raise ExtractError("This PDF has no text layer (it looks scanned). Scanned PDFs aren't supported.")

        pages = _strip_headers_footers(raw_pages)
        starts = _outline_starts(pdf)
    finally:
        pdf.close()

    chapters: list[Chapter] = []
    if starts:
        # Chapters can start mid-page: find each heading's offset in the full text.
        full = "\n".join(pages)
        page_offsets = [0]
        for p in pages:
            page_offsets.append(page_offsets[-1] + len(p) + 1)
        bounds: list[tuple[int, str]] = []
        pos = 0
        for page, ch_title in starts:
            lo = max(page_offsets[page], pos)
            hi = max(lo, page_offsets[page + 1])
            pos = _find_heading(full, ch_title, lo, hi)
            bounds.append((pos, ch_title))
        if bounds[0][0] > 0:
            bounds.insert(0, (0, "Front matter"))
        bounds.append((len(full), ""))
        for (start, ch_title), (end, _) in zip(bounds, bounds[1:]):
            chapters.append(Chapter(ch_title or f"Chapter {len(chapters) + 1}", clean(full[start:end])))
    else:
        for start in range(0, len(pages), PDF_PAGES_PER_CHUNK):
            end = min(start + PDF_PAGES_PER_CHUNK, len(pages))
            chapters.append(Chapter(f"Pages {start + 1}–{end}", clean("\n".join(pages[start:end]))))

    chapters = [c for c in chapters if len(c.text) >= MIN_CHAPTER_CHARS]
    return Book(title, author, chapters)
