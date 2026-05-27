# LUT files

Drop your technical transform LUTs here. The filenames below are what postie-rushes expects.

## Required files

| Filename                  | Source                                      |
|---------------------------|---------------------------------------------|
| `slog2_to_709.cube`       | Sony Creative Software — "SLog2SGamut_To_LC-709TypeA" or equivalent |
| `slog3_to_709.cube`       | Sony Creative Software — "SLog3SGamut3Cine_To_LC-709TypeA" |
| `dlog_m_to_709.cube`      | DJI — "D-Log M to Rec.709" (from DJI Color Assistant or firmware package) |

## Where to get them

- **Sony**: https://www.sony.com/en/articles/s-log2-s-log3-lut-package  
  Download the LUT package and use the `.cube` files from the `LC-709TypeA` folder.

- **DJI**: https://www.dji.com/downloads  
  Search for "DJI Color Assistant" — LUTs are included in the install package at:  
  `~/Library/Application Support/DJI Color Assistant/LUT/`

Rename whichever files you download to match the filenames above and place them in this folder.
