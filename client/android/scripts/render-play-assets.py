#!/usr/bin/env python3
"""Export existing BetterFrame vector branding at Google Play dimensions."""
import argparse
from copy import deepcopy
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SVG = 'http://www.w3.org/2000/svg'
ANDROID = '{http://schemas.android.com/apk/res/android}'
ET.register_namespace('', SVG)
ET.register_namespace('android', ANDROID[1:-1])
AAPT = '{http://schemas.android.com/aapt}'
ET.register_namespace('aapt', AAPT[1:-1])


def android_icon(icon):
    """Export the same brand geometry to Android's native vector format."""
    vector = ET.Element('vector', {ANDROID+'width': '108dp', ANDROID+'height': '108dp',
                                  ANDROID+'viewportWidth': '88', ANDROID+'viewportHeight': '88'})
    gradients = {node.get('id'): node for node in icon.iter(f'{{{SVG}}}linearGradient')}
    for node in icon:
        kind = node.tag.rsplit('}', 1)[-1]
        if kind not in ('rect', 'path'):
            continue
        data = node.get('d')
        if kind == 'rect':
            x, y, w, h, r = (float(node.get(key, '0')) for key in ('x', 'y', 'width', 'height', 'rx'))
            data = (f'M{x+r},{y} H{x+w-r} A{r},{r} 0 0 1 {x+w},{y+r} V{y+h-r} '
                    f'A{r},{r} 0 0 1 {x+w-r},{y+h} H{x+r} A{r},{r} 0 0 1 {x},{y+h-r} '
                    f'V{y+r} A{r},{r} 0 0 1 {x+r},{y} Z') if r else f'M{x},{y} h{w} v{h} h{-w} Z'
        path = ET.SubElement(vector, 'path', {ANDROID+'pathData': data})
        for svg_key, android_key in [('fill', 'fillColor'), ('stroke', 'strokeColor')]:
            value = node.get(svg_key, '#000000' if svg_key == 'fill' else 'none')
            if value == 'none':
                value = '#00000000'
            if value.startswith('url(#'):
                source = gradients[value[5:-1]]
                attr = ET.SubElement(path, AAPT+'attr', {'name': 'android:'+android_key})
                gradient = ET.SubElement(attr, 'gradient', {ANDROID+'type': 'linear',
                    **{ANDROID+dest: source.get(src) for src,dest in [('x1','startX'),('y1','startY'),('x2','endX'),('y2','endY')]}})
                for stop in source:
                    ET.SubElement(gradient, 'item', {ANDROID+'offset':stop.get('offset'), ANDROID+'color':stop.get('stop-color')})
            else:
                path.set(ANDROID+android_key, value)
        for src,dest in [('stroke-width','strokeWidth'),('stroke-linecap','strokeLineCap'),('stroke-linejoin','strokeLineJoin')]:
            if node.get(src): path.set(ANDROID+dest, node.get(src))
        if node.get('opacity'):
            path.set(ANDROID+'fillAlpha', node.get('opacity'))
            path.set(ANDROID+'strokeAlpha', node.get('opacity'))
    ET.indent(vector)
    ET.ElementTree(vector).write(ROOT/'app/src/main/res/drawable/bf_icon.xml', encoding='utf-8', xml_declaration=True)


def render(renderer):
    source = ROOT / 'play/assets/source'
    output = ROOT / 'play/assets/en-US'
    source.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    # Reuse the actual brand mark, excluding only its horizontal wordmark.
    # SVG is the source of truth: neither enlarge the small PNG nor redraw a logo.
    brand = ET.parse(ROOT.parent / 'assets/betterframe-logo-dark.svg').getroot()
    icon = ET.Element(f'{{{SVG}}}svg', width='512', height='512', viewBox='0 0 88 88')
    ET.SubElement(icon, f'{{{SVG}}}rect', width='88', height='88', fill='#0b111d')
    for element in brand:
        if element.tag.rsplit('}', 1)[-1] in ('defs', 'rect', 'path'):
            icon.append(deepcopy(element))
    android_icon(icon)
    assets = {'icon': icon}
    for name, width, height in [('feature-graphic',1024,500),('tv-banner',1280,720)]:
        canvas = ET.Element(f'{{{SVG}}}svg', width=str(width), height=str(height), viewBox=f'0 0 {width} {height}')
        ET.SubElement(canvas,f'{{{SVG}}}rect',width=str(width),height=str(height),fill='#0b111d')
        ET.SubElement(canvas,f'{{{SVG}}}rect',x='64',y=str(height-70),width=str(width-128),height='3',fill='#38bdf8')
        logo = ET.parse(ROOT.parent / 'assets/betterframe-logo-dark.svg').getroot()
        logo.set('x','54'); logo.set('y',str(int(height*.25)))
        logo.set('width',str(width-108)); logo.set('height',str(int((width-108)*88/360)))
        canvas.append(logo)
        copy = ET.SubElement(canvas,f'{{{SVG}}}text',x='72',y=str(int(height*.73)),fill='#cbd5e1',attrib={'font-family':'DejaVu Sans, sans-serif','font-size':'28'})
        copy.text='Camera views. Web content. Signage.'
        assets[name]=canvas
    for name, svg in assets.items():
        path = source / f'{name}.svg'
        ET.ElementTree(svg).write(path, encoding='utf-8', xml_declaration=True)
        subprocess.run([renderer, '--output',str(output/f'{name}.png'),str(path)],check=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--renderer',default='rsvg-convert')
    render(parser.parse_args().renderer)
