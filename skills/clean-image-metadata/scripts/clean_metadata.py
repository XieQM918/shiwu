#!/usr/bin/env python3
"""Fast local metadata cleanup; Python standard library + ExifTool."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
from datetime import datetime
import uuid

EXTENSIONS = {'.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WEBP'}
HISTORY = re.compile(r'_cleaned_\d{8}_\d{6}(?:_\d+)?$')
# Intentionally bounded verification scope, not an all-metadata guarantee.
VERIFY = ['-XMP:all', '-IPTC:all', '-JUMBF:all', '-GPS:all', '-MakerNotes:all',
          '-Software', '-ProcessingSoftware', '-ImageDescription', '-UserComment',
          '-Comment', '-Artist', '-Copyright', '-Make', '-Model', '-DocumentName',
          '-XPTitle', '-XPComment', '-XPAuthor', '-XPKeywords', '-XPSubject']
VERIFY += ['-PNG:' + x for x in ('Title Author Description Copyright CreationTime '
           'Software Disclaimer Warning Source Comment Parameters '
           'Document URL').split()]
ENV = dict(os.environ, LC_ALL='C', LANG='C')


def invoke(exe, args, paths):
    # Absolute paths cannot become options; reject newline paths before argfile use.
    data = '\n'.join([*args, *map(str, paths)]) + '\n'
    return subprocess.run([exe, '-config', '', '-charset', 'filename=UTF8', '-@', '-'],
                          input=data, text=True, encoding='utf-8', errors='replace',
                          capture_output=True, env=ENV)


def read_tags(exe, args, paths):
    result = invoke(exe, ['-j', '-G1', '-s', *args], paths)
    try:
        rows = json.loads(result.stdout)
        return {str(Path(row['SourceFile'])): row for row in rows}
    except (ValueError, KeyError, TypeError):
        raise RuntimeError('ExifTool 未返回有效的批量读取结果') from None


def special_chunks(path, fmt):
    """Read container chunk headers only, never decode image payloads."""
    if fmt not in ('PNG', 'WEBP'):
        return False
    size = path.stat().st_size
    with path.open('rb') as f:
        header = f.read(8 if fmt == 'PNG' else 12)
        if fmt == 'PNG' and header != b'\x89PNG\r\n\x1a\n':
            raise ValueError('PNG 文件头无效')
        if fmt == 'WEBP' and (header[:4] != b'RIFF' or header[8:] != b'WEBP'):
            raise ValueError('WebP 文件头无效')
        while f.tell() < size:
            chunk = f.read(8)
            if len(chunk) != 8:
                raise ValueError('图片块结构不完整')
            if fmt == 'PNG':
                length, kind = struct.unpack('>I4s', chunk)
                extra = 4
            else:
                kind, length = struct.unpack('<4sI', chunk)
                extra = length % 2
            if kind in (b'acTL', b'ANIM', b'ANMF', b'gmAP', b'gdAT', b'cICP'):
                return True
            if f.tell() + length + extra > size:
                raise ValueError('图片块长度无效')
            f.seek(length + extra, 1)
            if kind == b'IEND':
                break
    return False


def new_output(source):
    base = source.name + '_cleaned_' + datetime.now().strftime('%Y%m%d_%H%M%S')
    for n in range(10000):
        candidate = source.parent / (base + (f'_{n}' if n else ''))
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError('无法创建不重名的输出目录')


def clean(source, verify=False):
    source = Path(source).expanduser()
    if source.is_symlink():
        raise ValueError('输入目录不能是符号链接')
    source = source.resolve(strict=True)
    if not source.is_dir() or source == source.parent:
        raise ValueError('输入必须是非根目录的本地文件夹')
    if '\n' in str(source) or '\r' in str(source):
        raise ValueError('输入路径不能包含换行符')
    exe = shutil.which('exiftool')
    if not exe:
        raise RuntimeError('未找到 ExifTool，请先安装并加入 PATH')
    version = subprocess.run([exe, '-config', '', '-ver'], capture_output=True,
                             text=True, env=ENV)
    if version.returncode:
        raise RuntimeError('ExifTool 无法运行')
    report = {'output_directory': None, 'verify_requested': verify, 'success': 0,
              'skipped': 0, 'failed': 0, 'warnings': 0, 'issues': []}

    def issue(path, status, reason):
        report[status] += 1
        report['issues'].append({'file': str(path.relative_to(source)),
                                 'status': status, 'reason': reason})

    candidates = []
    def walk_error(error):
        raise OSError('无法完整读取输入目录') from error
    for root, dirs, files in os.walk(source, onerror=walk_error, followlinks=False):
        parent = Path(root)
        for name in list(dirs):
            p = parent / name
            if name.startswith('.') or p.is_symlink() or HISTORY.search(name):
                dirs.remove(name)
                issue(p, 'skipped', '跳过隐藏目录、符号链接或历史输出目录（按目录计数）')
        for name in sorted(files):
            p = parent / name
            if p.is_symlink() or name.startswith('.') or p.suffix.lower() not in EXTENSIONS:
                issue(p, 'skipped', '隐藏文件、符号链接或不支持的格式')
            elif '\n' in str(p) or '\r' in str(p):
                issue(p, 'skipped', '文件路径包含换行符')
            else:
                candidates.append(p)
    output = new_output(source)  # Atomic creation also checks parent write permission.
    report['output_directory'] = str(output)
    groups = {key: [] for key in set(EXTENSIONS.values())}
    if candidates:
        rows = read_tags(exe, ['-FileType', '-Error', '-Warning', '-MPF:all',
                              '-HDRGainMapVersion', '-GainMapImage', '-ImageCount'], candidates)
        for p in candidates:
            row = rows.get(str(p), {})
            fmt = str(row.get('File:FileType', '')).upper()
            if fmt in ('EXTENDED WEBP', 'LOSSLESS WEBP'):
                fmt = 'WEBP'
            if not row or any(k.endswith(':Error') for k in row):
                issue(p, 'failed', 'ExifTool 无法读取图片')
                continue
            if fmt == 'APNG':
                issue(p, 'skipped', '动画 PNG')
                continue
            if fmt != EXTENSIONS[p.suffix.lower()]:
                issue(p, 'skipped', '实际格式与文件扩展名不符')
                continue
            dest = output / p.relative_to(source)
            try:
                special = special_chunks(p, fmt) or any(
                    k.startswith('MPF:') or k.endswith((':HDRGainMapVersion', ':GainMapImage'))
                    or (k.endswith(':ImageCount') and int(v) > 1) for k, v in row.items())
                if special:
                    issue(p, 'skipped', '动画、多图或特殊颜色/增益图结构')
                    continue
                dest = output / p.relative_to(source)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, dest)
                groups[fmt].append((p, dest))
                if any(k.endswith(':Warning') for k in row):
                    issue(p, 'warnings', '读取时存在 ExifTool 警告')
            except (OSError, ValueError):
                dest.unlink(missing_ok=True)
                issue(p, 'failed', '读取结构或复制文件失败')
    successes = []
    for fmt, pairs in groups.items():
        if not pairs:
            continue
        token = uuid.uuid4().hex
        args = []
        for i, (_, dest) in enumerate(pairs):
            marker = f'__{token}_{i}__'
            args += ['-overwrite_original', '-all=', '--ICC_Profile:all',
                     '-tagsFromFile', '@', '-Orientation', '-ColorSpaceTags',
                     '-echo3', marker + '${status}', '-echo4', marker,
                     str(dest), '-execute']
        result = invoke(exe, args, [])
        stdout, stderr = result.stdout, result.stderr
        for i, (p, dest) in enumerate(pairs):
            marker = f'__{token}_{i}__'
            match = re.search(re.escape(marker) + r'(\d+)\r?\n', stdout)
            err_parts = stderr.split(marker, 1)
            err = err_parts[0]
            stderr = err_parts[1].lstrip('\r\n') if len(err_parts) == 2 else ''
            if match:
                stdout = stdout[match.end():]
            ok = match and match.group(1) == '0' and dest.is_file() and dest.stat().st_size > 0
            if not ok:
                dest.unlink(missing_ok=True)
                issue(p, 'failed', 'ExifTool 清理失败或未生成有效输出')
            else:
                successes.append((p, dest))
                if err.strip():
                    issue(p, 'warnings', '清理时存在 ExifTool 警告；未保存可能包含元数据值的原文')
    if verify and successes:
        try:
            rows = read_tags(exe, VERIFY, [dest for _, dest in successes])
        except RuntimeError:
            rows = {}
        verified = []
        for p, dest in successes:
            row = rows.get(str(dest))
            remaining = [k for k in (row or {}) if k != 'SourceFile']
            if row is None or remaining:
                dest.unlink(missing_ok=True)
                issue(p, 'failed', '复查未通过：' + (', '.join(remaining) if remaining else '无法读取'))
            else:
                verified.append((p, dest))
        successes = verified
    report['success'] = len(successes)
    report['status'] = '已复查' if verify else '处理完成'
    (output / '处理报告.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input_directory', help='待处理图片文件夹')
    parser.add_argument('--verify', action='store_true', help='增加一次批量元数据复查')
    args = parser.parse_args()
    try:
        report = clean(args.input_directory, args.verify)
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({'status': '任务未完成', 'error': str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report['failed'] else 0


if __name__ == '__main__':
    sys.exit(main())
