textures/pxl_light/wsupprt1_noflare
{
	qer_editorimage textures/base_light/wsupprt1_12.tga
	q3map_lightimage textures/base_light/wsupprt1_12.tga
	surfaceparm nomarks
	q3map_surfacelight 100
	{
		map textures/base_light/wsupprt1_12.tga
		rgbGen identity
	}
}

textures/pxl_fx/jumpcircle1
{
	qer_editorimage textures/pxl_fx/jumpcircle.jpg
	surfaceparm nodlight
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm trans
	cull disable
	nomipmaps
	deformVertexes move 0 0 32 sawtooth 0 1 0 1.5 
	{
		clampmap textures/pxl_fx/jumpcircle.jpg
		blendfunc add
		tcMod stretch sawtooth 0.25 0.5 0 1.5 
		tcMod rotate 120
	}
}

textures/pxl_fx/jumpcircle2
{
	qer_editorimage textures/pxl_fx/jumpcircle.jpg
	surfaceparm nodlight
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm trans
	cull disable
	nomipmaps
	deformVertexes move 0 0 32 sawtooth 0 1 0.5 1.5 
	{
		clampmap textures/pxl_fx/jumpcircle.jpg
		blendfunc add
		tcMod stretch sawtooth 0.25 0.5 0.5 1.5 
		tcMod rotate -120
	}
}

textures/pxl_fx/letter_a
{
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	polygonoffset
	{
		map textures/pxl_fx/letter_a.tga
		blendfunc blend
		rgbGen Vertex
	}
}

textures/pxl_fx/letter_b
{
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	polygonoffset
	{
		map textures/pxl_fx/letter_b.tga
		blendfunc blend
		rgbGen Vertex
	}
}

textures/pxl_fx/weaponbase_iconrl
{
	qer_editorimage textures/pxl_fx/weaponbase_spin_fx_rl.tga
	q3map_lightimage textures/pxl_fx/weaponbase_spin_fx_rl.tga
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	nomipmaps
	polygonoffset
	{
		clampmap icons/iconw_rocket.tga
		blendfunc blend
		rgbGen wave sin 0.5 0.5 0 1 
		tcMod rotate -90
		tcMod stretch sawtooth 0.15 0 0 1 
	}
	{
		clampmap textures/pxl_fx/weaponbase_spin_fx_rl.tga
		blendfunc blend
		tcMod rotate 90
	}
}

textures/pxl_fx/weaponbase_iconlg
{
	qer_editorimage textures/pxl_fx/weaponbase_spin_fx_lg.tga
	q3map_lightimage textures/pxl_fx/weaponbase_spin_fx_lg.tga
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	nomipmaps
	polygonoffset
	{
		clampmap icons/iconw_lightning.tga
		blendfunc blend
		rgbGen wave sin 0.5 0.5 0 1 
		tcMod rotate -90
		tcMod stretch sawtooth 0.15 0 0 1 
	}
	{
		clampmap textures/pxl_fx/weaponbase_spin_fx_lg.tga
		blendfunc blend
		tcMod rotate 90
	}
}

textures/pxl_fx/weaponbase_iconrg
{
	qer_editorimage textures/pxl_fx/weaponbase_spin_fx_rg.tga
	q3map_lightimage textures/pxl_fx/weaponbase_spin_fx_rg.tga
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	nomipmaps
	polygonoffset
	{
		clampmap icons/iconw_railgun.tga
		blendfunc blend
		rgbGen wave sin 0.5 0.5 0 1 
		tcMod rotate -90
		tcMod stretch sawtooth 0.15 0 0 1 
	}
	{
		clampmap textures/pxl_fx/weaponbase_spin_fx_rg.tga
		blendfunc blend
		tcMod rotate 90
	}
}

