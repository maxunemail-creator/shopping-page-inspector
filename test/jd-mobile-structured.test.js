import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJdMobileStructured } from '../src/jd-mobile-structured.js';

test('extracts exact JD mobile SKU variant and main images', () => {
  const html = `
    <script>
      window._itemOnly = ({
        "item": {
          "image": ["jfs/a.jpg", "jfs/b.jpg"],
          "brandName": "奕洲",
          "salePropSeq": {
            "1": ["黑胡桃+黑架【25mm实木桌面】"],
            "2": ["120*60*170cm【书架洞洞板】", "140*60*170cm【书架洞洞板】"]
          },
          "saleProp": {"1":"颜色","2":"尺寸"},
          "newColorSize": [
            {"color":"黑胡桃+黑架【25mm实木桌面】","size":"120*60*170cm【书架洞洞板】","imagePath":"jfs/a.jpg","skuId":"101"},
            {"color":"黑胡桃+黑架【25mm实木桌面】","size":"140*60*170cm【书架洞洞板】","imagePath":"jfs/a.jpg","skuId":"102"},
          ],
          "skuId": "101",
        },
      });
      window._itemInfo = ({
        "product": {
          "skuId":"101",
          "skuName":"奕洲测试桌 黑胡桃+黑架 120*60*170cm",
          "imageurl":"jfs/a.jpg",
          "color":"黑胡桃+黑架【25mm实木桌面】",
          "size":"120*60*170cm【书架洞洞板】",
          "width":"600",
          "height":"750",
          "length":"1300",
        },
      });
    </script>`;

  const result = extractJdMobileStructured(html, '101');
  assert.equal(result.brandName, '奕洲');
  assert.equal(result.selectedVariant.skuId, '101');
  assert.equal(result.selectedVariant.size, '120*60*170cm【书架洞洞板】');
  assert.deepEqual(result.sizes, ['120*60*170cm【书架洞洞板】', '140*60*170cm【书架洞洞板】']);
  assert.equal(result.variants.length, 2);
  assert.equal(result.mainImageUrls[0], 'https://m.360buyimg.com/mobilecms/jfs/a.jpg');
  assert.equal(result.selectedImageUrl, 'https://m.360buyimg.com/mobilecms/jfs/a.jpg');
  assert.equal(result.rawProductFields.length, '1300');
  assert.match(result.dimensionSemantics, /not assumed/i);
});
