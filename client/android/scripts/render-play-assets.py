#!/usr/bin/env python3
"""Export existing BetterFrame vector branding at Google Play dimensions."""
import argparse
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SVG = 'http://www.w3.org/2000/svg'
ANDROID = '{http://schemas.android.com/apk/res/android}'
ET.register_namespace('', SVG)


def render(renderer):
    source = ROOT / 'play/assets/source'
    output = ROOT / 'play/assets/en-US'
    source.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    vector = ET.parse(ROOT / 'app/src/main/res/drawable/bf_icon.xml').getroot()
    icon = ET.Element(f'{{{SVG}}}svg', width='512', height='512', viewBox='0 0 108 108')
    for path in vector:
        ET.SubElement(icon, f'{{{SVG}}}path', fill=path.get(ANDROID+'fillColor'), d=path.get(ANDROID+'pathData'))
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
