'Create thumbnail grids from PowerPoint presentation slides.\n\nCreates a grid layout of slide thumbnails for quick visual analysis.\nLabels each thumbnail with its XML filename (e.g., slide1.xml).\nHidden slides are shown with a placeholder pattern.\nEach grid image contains at most 4 slides (2x2 layout by default).\n\nUsage:\n    python thumbnail.py input.pptx [output_prefix] [--cols N]\n    python thumbnail.py input.pptx output_dir --per-page\n    python thumbnail.py input.pptx output_dir --per-page --pages 3,5,8\n\nExamples:\n    python thumbnail.py presentation.pptx\n    # Creates: thumbnails.jpg (or thumbnails-1.jpg, thumbnails-2.jpg for >4 slides)\n\n    python thumbnail.py template.pptx grid --cols 4\n    # Creates: grid-1.jpg, grid-2.jpg, ... (4 slides per image)\n\n    python thumbnail.py presentation.pptx ./slides --per-page\n    # Creates: slides/p01.jpg, slides/p02.jpg, ... (one image per slide,\n    # numbered by presentation order)\n\n    python thumbnail.py presentation.pptx ./slides --per-page --pages 3,5,8\n    # Only saves specified pages (p03.jpg, p05.jpg, p08.jpg)\n'
import argparse
import posixpath
import sys
import tempfile
import zipfile
from pathlib import Path
import defusedxml.minidom
from cloud_render import CloudRenderError, convert_pptx_to_images
from defusedxml import ElementTree
from local_render import LocalRenderError, convert_pptx_to_images_local, fallback_mode
from PIL import Image, ImageDraw, ImageFont
THUMBNAIL_WIDTH = 300
CONVERSION_DPI = 100
MAX_COLS = 4
DEFAULT_COLS = 2
MAX_SLIDES_PER_GRID = 4
JPEG_QUALITY = 95
GRID_PADDING = 20
BORDER_WIDTH = 2
FONT_SIZE_RATIO = 0.1
LABEL_PADDING_RATIO = 0.4

def main():
    parser = argparse.ArgumentParser(description='Create thumbnail grids from PowerPoint slides.')
    parser.add_argument('input', help='Input PowerPoint file (.pptx)')
    parser.add_argument('output_prefix', nargs='?', default='thumbnails', help='Output prefix for image files (default: thumbnails)')
    parser.add_argument('-o', '--output', dest='output_flag', default=None, help='Convenience alias for the output_prefix positional argument')
    parser.add_argument('--cols', type=int, default=DEFAULT_COLS, help=f'Number of columns (default: {DEFAULT_COLS}, max: {MAX_COLS})')
    parser.add_argument('--per-page', action='store_true', help='Output one image per slide (output_prefix is used as directory)')
    parser.add_argument('--pages', default='', help='Comma-separated 1-based page numbers to save (e.g. 3,5,8). Only effective with --per-page. Other pages are still rendered but not saved.')
    parser.add_argument('--dpi', type=int, default=CONVERSION_DPI, help=f'渲染分辨率 DPI；文本密集页建议至少 200（默认 {CONVERSION_DPI}）')
    args = parser.parse_args()
    if args.output_flag is not None:
        args.output_prefix = args.output_flag
    input_path = Path(args.input)
    if not input_path.exists() or input_path.suffix.lower() not in ('.pptx', '.potx'):
        print(f'Error: Invalid PowerPoint file: {args.input}', file=sys.stderr)
        sys.exit(1)
    try:
        slide_info = get_slide_info(input_path)
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            rendered_images = convert_to_images(input_path, temp_path, args.dpi, expected_page_count=len(slide_info))
            if not rendered_images and (not any((s['hidden'] for s in slide_info))):
                print('Error: No slides found', file=sys.stderr)
                sys.exit(1)
            slides = build_slide_list(slide_info, rendered_images, temp_path)
            if args.per_page:
                output_dir = Path(args.output_prefix)
                output_dir.mkdir(parents=True, exist_ok=True)
                page_filter = None
                if args.pages:
                    page_filter = set((int(p.strip()) for p in args.pages.split(',') if p.strip()))
                output_files = save_per_page(slides, output_dir, page_filter)
                print(f'Created {len(output_files)} slide image(s) in {output_dir}/')
            else:
                cols = min(args.cols, MAX_COLS)
                if args.cols > MAX_COLS:
                    print(f'Warning: columns limited to {MAX_COLS}', file=sys.stderr)
                output_path = Path(f'{args.output_prefix}.jpg')
                grid_files = create_grids(slides, cols, THUMBNAIL_WIDTH, output_path)
                print(f'Created {len(grid_files)} grid(s) from {len(slides)} slide(s) with prefix {output_path}')
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)

def _relationship_target(target: str) -> str | None:
    if not target or '://' in target:
        return None
    if target.startswith('/'):
        part = target.lstrip('/')
    else:
        part = posixpath.normpath(posixpath.join('ppt', target))
    if part.startswith('../') or part == '..':
        return None
    return part

def _is_hidden(zf: zipfile.ZipFile, part: str) -> bool:
    try:
        root = ElementTree.fromstring(zf.read(part))
    except (KeyError, ElementTree.ParseError):
        return False
    return root.get('show', '').lower() in ('0', 'false')

def get_slide_info(pptx_path: Path) -> list[dict]:
    with zipfile.ZipFile(pptx_path, 'r') as zf:
        rels_content = zf.read('ppt/_rels/presentation.xml.rels').decode('utf-8')
        rels_dom = defusedxml.minidom.parseString(rels_content)
        rid_to_part = {}
        for rel in rels_dom.getElementsByTagName('Relationship'):
            rid = rel.getAttribute('Id')
            target = rel.getAttribute('Target')
            rel_type = rel.getAttribute('Type')
            if rel_type.endswith('/slide') and (not rel.getAttribute('TargetMode')):
                part = _relationship_target(target)
                if part is not None:
                    rid_to_part[rid] = part
        pres_content = zf.read('ppt/presentation.xml').decode('utf-8')
        pres_dom = defusedxml.minidom.parseString(pres_content)
        slides = []
        for sld_id in pres_dom.getElementsByTagName('p:sldId'):
            rid = sld_id.getAttribute('r:id')
            part = rid_to_part.get(rid)
            if part is not None and part in zf.namelist():
                legacy_hidden = sld_id.getAttribute('show').lower() in ('0', 'false')
                slides.append({'name': posixpath.basename(part), 'hidden': legacy_hidden or _is_hidden(zf, part)})
        return slides

def build_slide_list(slide_info: list[dict], rendered_images: list[Path], temp_dir: Path) -> list[tuple[Path, str]]:
    visible_count = sum((1 for info in slide_info if not info['hidden']))
    rendered_hidden = len(rendered_images) == len(slide_info) != visible_count
    if len(rendered_images) not in (visible_count, len(slide_info)):
        raise ValueError(f'Renderer returned {len(rendered_images)} image(s) for {visible_count} visible slide(s) of {len(slide_info)}; thumbnails would be mislabeled')
    if rendered_images:
        with Image.open(rendered_images[0]) as img:
            placeholder_size = img.size
    else:
        placeholder_size = (1920, 1080)
    slides = []
    visible_idx = 0
    for info in slide_info:
        if info['hidden']:
            if rendered_hidden:
                visible_idx += 1
            placeholder_path = temp_dir / f"hidden-{info['name']}.jpg"
            placeholder_img = create_hidden_placeholder(placeholder_size)
            placeholder_img.save(placeholder_path, 'JPEG')
            slides.append((placeholder_path, f"{info['name']} (hidden)"))
        elif visible_idx < len(rendered_images):
            slides.append((rendered_images[visible_idx], info['name']))
            visible_idx += 1
    return slides

def create_hidden_placeholder(size: tuple[int, int]) -> Image.Image:
    img = Image.new('RGB', size, color='#F0F0F0')
    draw = ImageDraw.Draw(img)
    line_width = max(5, min(size) // 100)
    draw.line([(0, 0), size], fill='#CCCCCC', width=line_width)
    draw.line([(size[0], 0), (0, size[1])], fill='#CCCCCC', width=line_width)
    return img

def convert_to_images(pptx_path: Path, temp_dir: Path, dpi: int=CONVERSION_DPI, expected_page_count: int | None=None) -> list[Path]:
    expected_page_count = expected_page_count or len(get_slide_info(pptx_path))
    cloud_dir = temp_dir / 'cloud'
    try:
        outputs = convert_pptx_to_images(pptx_path, cloud_dir, dpi, expected_page_count)
        print(f'Cloud renderer created {len(outputs)} page image(s)', file=sys.stderr)
        return outputs
    except CloudRenderError as cloud_error:
        if not cloud_error.fallback_allowed:
            raise
        mode = fallback_mode()
        if mode == 'off':
            raise RuntimeError(f'Cloud render failed and local fallback is disabled: {cloud_error}') from cloud_error
        print(f'Cloud render failed; using local fallback ({mode}): {cloud_error}', file=sys.stderr)
        try:
            return convert_pptx_to_images_local(pptx_path, temp_dir / 'local', dpi, mode)
        except LocalRenderError as local_error:
            raise RuntimeError(f'Both cloud render and local fallback failed: cloud={cloud_error}; local={local_error}') from local_error

def save_per_page(slides: list[tuple[Path, str]], output_dir: Path, page_filter: set[int] | None=None) -> list[str]:
    "Save each slide as an individual image file.\n\n    Named by 1-based presentation order (`p01.jpg`), not by the slide's XML\n    filename: package numbering can be non-sequential, and downstream steps\n    address slides by presentation index.\n\n    If page_filter is provided, only saves pages whose 1-based index is in the set.\n    "
    output_files = []
    for i, (img_path, _slide_name) in enumerate(slides, 1):
        if page_filter and i not in page_filter:
            continue
        out_path = output_dir / f'p{i:02d}.jpg'
        with Image.open(img_path) as img:
            img.save(str(out_path), 'JPEG', quality=JPEG_QUALITY)
        output_files.append(str(out_path))
    return output_files

def create_grids(slides: list[tuple[Path, str]], cols: int, width: int, output_path: Path) -> list[str]:
    max_per_grid = MAX_SLIDES_PER_GRID
    grid_files = []
    for chunk_idx, start_idx in enumerate(range(0, len(slides), max_per_grid)):
        end_idx = min(start_idx + max_per_grid, len(slides))
        chunk_slides = slides[start_idx:end_idx]
        chunk_cols = min(cols, len(chunk_slides))
        grid = create_grid(chunk_slides, chunk_cols, width)
        if len(slides) <= max_per_grid:
            grid_filename = output_path
        else:
            stem = output_path.stem
            suffix = output_path.suffix
            grid_filename = output_path.parent / f'{stem}-{chunk_idx + 1}{suffix}'
        grid_filename.parent.mkdir(parents=True, exist_ok=True)
        grid.save(str(grid_filename), quality=JPEG_QUALITY)
        grid_files.append(str(grid_filename))
    return grid_files

def create_grid(slides: list[tuple[Path, str]], cols: int, width: int) -> Image.Image:
    font_size = int(width * FONT_SIZE_RATIO)
    label_padding = int(font_size * LABEL_PADDING_RATIO)
    with Image.open(slides[0][0]) as img:
        aspect = img.height / img.width
    height = int(width * aspect)
    rows = (len(slides) + cols - 1) // cols
    grid_w = cols * width + (cols + 1) * GRID_PADDING
    grid_h = rows * (height + font_size + label_padding * 2) + (rows + 1) * GRID_PADDING
    grid = Image.new('RGB', (grid_w, grid_h), 'white')
    draw = ImageDraw.Draw(grid)
    try:
        font = ImageFont.load_default(size=font_size)
    except Exception:
        font = ImageFont.load_default()
    for i, (img_path, slide_name) in enumerate(slides):
        row, col = (i // cols, i % cols)
        x = col * width + (col + 1) * GRID_PADDING
        y_base = row * (height + font_size + label_padding * 2) + (row + 1) * GRID_PADDING
        label = slide_name
        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        draw.text((x + (width - text_w) // 2, y_base + label_padding), label, fill='black', font=font)
        y_thumbnail = y_base + label_padding + font_size + label_padding
        with Image.open(img_path) as img:
            img.thumbnail((width, height), Image.Resampling.LANCZOS)
            w, h = img.size
            tx = x + (width - w) // 2
            ty = y_thumbnail + (height - h) // 2
            grid.paste(img, (tx, ty))
            if BORDER_WIDTH > 0:
                draw.rectangle([(tx - BORDER_WIDTH, ty - BORDER_WIDTH), (tx + w + BORDER_WIDTH - 1, ty + h + BORDER_WIDTH - 1)], outline='gray', width=BORDER_WIDTH)
    return grid
if __name__ == '__main__':
    main()
