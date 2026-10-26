import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../src/core/text/entities';
import {
  collectImageSources,
  sanitizeDocument,
  type SanitizedBlock,
  type SanitizeOptions,
} from '../src/core/epub/sanitize';

/** 近似 DOM 的 textContent：去掉标签、还原实体（本模块生成的属性里不含裸 '>'）。 */
function textContentOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

function assertInvariant(html: string, options?: SanitizeOptions): SanitizedBlock[] {
  const document = sanitizeDocument(html, options);
  for (const block of document.blocks) {
    expect(block.text).toBe(textContentOf(block.html));
    expect(block.end - block.start).toBe(block.text.length);
  }
  const texts = document.blocks.filter((block) => block.text.length > 0);
  expect(document.text).toBe(texts.map((block) => block.text).join('\n'));
  let cursor = 0;
  for (const block of texts) {
    expect(block.start).toBe(cursor);
    cursor = block.end + 1;
  }
  return document.blocks;
}

describe('sanitizeDocument 不变量', () => {
  it('块文本与渲染后的 textContent 完全一致', () => {
    assertInvariant('<body><p>第一段文字</p><h1>标题</h1><p>第二段</p></body>');
  });

  it('跨标签的空白整块折叠，且空格落在有内容的文本里', () => {
    const document = sanitizeDocument('<p>Hello   <b>  world </b>  again</p>');
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].text).toBe('Hello world again');
    // 折叠出的空格会落到「下一个有内容的文本节点」里，这里落在 <b> 内
    expect(document.blocks[0].html).toBe('Hello<b> world</b> again');
    expect(textContentOf(document.blocks[0].html)).toBe('Hello world again');
  });

  it('标签之间的空格不会丢失也不会重复', () => {
    const document = sanitizeDocument('<p><b>a</b> <i>b</i></p>');
    expect(document.blocks[0].text).toBe('a b');
    expect(textContentOf(document.blocks[0].html)).toBe('a b');
  });

  it('块首尾空白被裁掉', () => {
    const document = sanitizeDocument('<p>\n\n   只有正文   \n</p>');
    expect(document.blocks[0].text).toBe('只有正文');
  });

  it('实体解码后再转义，文本与 HTML 都正确', () => {
    const document = sanitizeDocument('<p>a &amp; b &lt;c&gt; &#39;d&#39;</p>');
    expect(document.blocks[0].text).toBe("a & b <c> 'd'");
    expect(document.blocks[0].html).toBe('a &amp; b &lt;c&gt; &#39;d&#39;');
  });
});

describe('sanitizeDocument 行内标签', () => {
  it('保留强调类行内标签，但去掉属性', () => {
    const document = sanitizeDocument(
      '<p>x<b class="a">粗</b><em>斜</em><code>c</code></p>',
    );
    expect(document.blocks[0].html).toBe('x<b>粗</b><em>斜</em><code>c</code>');
    expect(document.blocks[0].text).toBe('x粗斜c');
  });

  it('未知行内标签透明处理：丢标签、留文字', () => {
    const document = sanitizeDocument('<p>a<blink>b</blink>c</p>');
    expect(document.blocks[0].html).toBe('abc');
    expect(document.blocks[0].text).toBe('abc');
  });

  it('脚本、样式与 head 整棵子树被丢弃', () => {
    const document = sanitizeDocument(
      '<head><title>T</title></head><body><p>正文</p><script>evil()</script><style>p{}</style></body>',
    );
    expect(document.text).toBe('正文');
    expect(document.blocks[0].html).not.toContain('evil');
  });
});

describe('sanitizeDocument 空元素与图片', () => {
  it('<br> 两侧都不产生字符', () => {
    const document = sanitizeDocument('<p>上<br/>下</p>');
    expect(document.blocks[0].text).toBe('上下');
    expect(document.blocks[0].html).toBe('上<br>下');
  });

  it('图片不占字符，纯图片块 start === end', () => {
    const blocks = assertInvariant(
      '<body><p>文字</p><p><img src="a.png"/></p><p>结尾</p></body>',
      { resolveImage: (src) => `data:image/png;base64,${src}` },
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[1].text).toBe('');
    expect(blocks[1].start).toBe(blocks[1].end);
    expect(blocks[1].html).toContain('<img src="data:image/png;base64,a.png">');
  });

  it('解析不出图片时整块被丢弃', () => {
    const blocks = sanitizeDocument('<body><p>文字</p><p><img src="a.png"/></p></body>', {
      resolveImage: () => null,
    });
    expect(blocks.blocks).toHaveLength(1);
    expect(blocks.text).toBe('文字');
  });

  it('SVG 里的 <image> 按位图渲染', () => {
    const blocks = sanitizeDocument(
      '<body><svg><image xlink:href="cover.jpg"/></svg></body>',
      { resolveImage: (src) => `data:image/jpeg;base64,${src}` },
    );
    expect(blocks.blocks).toHaveLength(1);
    expect(blocks.blocks[0].text).toBe('');
    expect(blocks.blocks[0].html).toContain('data:image/jpeg;base64,cover.jpg');
  });
});

describe('sanitizeDocument 块结构', () => {
  it('容器标签递归展开为多个段落', () => {
    const document = sanitizeDocument('<div><section><p>a</p><p>b</p></section></div>');
    expect(document.blocks.map((block) => block.text)).toEqual(['a', 'b']);
    expect(document.blocks.every((block) => block.tag === 'p')).toBe(true);
  });

  it('列表与标题保留块级标签用于样式', () => {
    const document = sanitizeDocument('<h1>标题</h1><ul><li>一</li><li>二</li></ul>');
    expect(document.blocks.map((block) => block.tag)).toEqual(['h1', 'li', 'li']);
    expect(document.text).toBe('标题\n一\n二');
  });

  it('裸文本会被收进一个隐式段落', () => {
    const document = sanitizeDocument('<body>裸文本</body>');
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].tag).toBe('p');
    expect(document.blocks[0].text).toBe('裸文本');
  });

  it('只有空白的文档得到空文本', () => {
    const document = sanitizeDocument('<body><p>   </p><p></p></body>');
    expect(document.text).toBe('');
    expect(document.blocks).toHaveLength(0);
  });
});

describe('collectImageSources', () => {
  it('按出现顺序去重收集 img 与 image 的引用', () => {
    const sources = collectImageSources(
      '<p><img src="a.png"/><img src="b.png"/><img src="a.png"/><image xlink:href="c.svg"/></p>',
    );
    expect(sources).toEqual(['a.png', 'b.png', 'c.svg']);
  });

  it('没有图片时返回空数组', () => {
    expect(collectImageSources('<p>只有文字</p>')).toEqual([]);
  });
});