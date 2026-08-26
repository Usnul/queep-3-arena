// missing openarena textures for PUL1DUEL
textures/gothic_trim/column2c_trans
{
	qer_editorimage textures/gothic_trim/column2c_test.tga
	surfaceparm nonsolid
	{
		map $lightmap 
		rgbGen identity
		tcGen lightmap 
	}
	{
		map textures/gothic_trim/column2c_test.tga
		blendfunc filter
		rgbGen identity
	}
}

textures/common/skip
{
	qer_nocarve
	qer_trans 0.40
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm structural
	surfaceparm trans
}

textures/base_trim/pewter_nonsolid
{
	qer_editorimage textures/base_trim/dirty_pewter.tga
	surfaceparm nonsolid
	{
		map $lightmap
		rgbGen identity
	}
	{
		map textures/base_trim/dirty_pewter.tga
		rgbGen identity
		blendFunc filter
	}
}

textures/base_light/border7_ceil50
{
	qer_editorimage textures/base_light/border7_ceil50.tga
	q3map_surfacelight 100
	{
		map $lightmap
		rgbGen identity
	}
	{
		map textures/base_light/border7_ceil50.tga
		blendFunc filter
		rgbGen identity
	}
	{
		map textures/base_light/border7_ceil50glow.tga
		blendfunc add
	}
}
	

textures/base_light/scrolllight
{
	qer_editorimage textures/base_light/scrolllight.tga
	q3map_lightimage textures/sfx2/n_blur.tga
	q3map_surfacelight 100
	{
		map $lightmap 
		rgbGen identity
		tcGen lightmap 
	}
	{
		map textures/base_light/scrolllight.tga
		blendfunc filter
		rgbGen identity
	}
	{
		map textures/base_light/scrolllight2.tga
		blendfunc add
		tcMod scroll -1 0
	}
	{
		map textures/base_light/scrolllight2.tga
		blendfunc add
		tcMod scroll -2 0
	}
}

textures/base_light/scrolllight_red
{
	qer_editorimage textures/base_light/scrolllight.tga
	q3map_lightimage textures/sfx2/r_blur.tga
	q3map_surfacelight 100
	{
		map $lightmap 
		rgbGen identity
		tcGen lightmap 
	}
	{
		map textures/base_light/scrolllight.tga
		blendfunc filter
		rgbGen identity
	}
	{
		map textures/base_light/scrolllight2_r.tga
		blendfunc add
		tcMod scroll -1 0
	}
	{
		map textures/base_light/scrolllight2_r.tga
		blendfunc add
		tcMod scroll -2 0
	}
}

textures/base_light/scrolllight_blue
{
	qer_editorimage textures/base_light/scrolllight.tga
	q3map_lightimage textures/sfx2/r_blur.tga
	q3map_surfacelight 100
	{
		map $lightmap 
		rgbGen identity
		tcGen lightmap 
	}
	{
		map textures/base_light/scrolllight.tga
		blendfunc filter
		rgbGen identity
	}
	{
		map textures/base_light/scrolllight2_b.tga
		blendfunc add
		tcMod scroll -1 0
	}
	{
		map textures/base_light/scrolllight2_b.tga
		blendfunc add
		tcMod scroll -2 0
	}
}

