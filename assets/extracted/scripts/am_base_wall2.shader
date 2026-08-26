textures/base_wall2/ntrl_techfloor_kc
{
	surfaceparm nomarks
	surfaceparm trans
	surfaceparm pointlight
	surfaceparm nonsolid

	nopicmip
	polygonoffset
	{
		clampmap textures/base_wall2/ntrl_techfloor_kc.tga
		alphafunc GE128
		depthwrite
		tcMod rotate 45
	}
	{
		map $lightmap
		rgbgen identity
		blendfunc filter
		depthfunc equal
	}
}
textures/base_wall2/techfloor_kc
{
	surfaceparm nomarks
	surfaceparm trans
	surfaceparm pointlight
	surfaceparm nonsolid

	nopicmip
	polygonoffset
	{
		clampmap textures/base_wall2/techfloor_kc.tga
		alphafunc GE128
		depthwrite
		tcMod rotate 45
	}
	{
		map $lightmap
		rgbgen identity
		blendfunc filter
		depthfunc equal
	}
}
textures/base_wall2/techfloor_kc_blue
{
	surfaceparm nomarks
	surfaceparm trans
	surfaceparm pointlight
	surfaceparm nonsolid

	nopicmip
	polygonoffset
	{
		clampmap textures/base_wall2/techfloor_kc_blue.tga
		alphafunc GE128
		depthwrite
		tcMod rotate 45
	}
	{
		map $lightmap
		rgbgen identity
		blendfunc filter
		depthfunc equal
	}
}

