textures/pulchr/playerclipnosound
{
	qer_editorimage textures/common/clip.tga
	surfaceparm nodamage
	surfaceparm nodraw
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm nosteps
	surfaceparm playerclip
	qer_trans 0.4
}

textures/pulchr/botclipnosound
{
	qer_editorimage textures/common/botclip.tga
	surfaceparm nodamage
	surfaceparm nodraw
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm nosteps
	surfaceparm trans
	surfaceparm botclip
	qer_trans 0.4
}

textures/pulchr/beam-white-pulchr
{
	qer_editorimage textures/pulchr/beam-pulchr-white.tga
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	cull disable
	nomipmaps
	q3map_surfacelight 150
	{
		map textures/pulchr/beam-pulchr-white.tga
		blendfunc add
	}
}

textures/pulchr/telebeam
{
	qer_editorimage textures/pulchr/beam-teleporter.tga
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nonsolid
	surfaceparm trans
	cull disable
	nomipmaps
	q3map_surfacelight 150
	{
		map textures/pulchr/beam-teleporter.tga
		blendfunc add
	}
}

textures/pulchr/fivestepspindel
{
	qer_editorimage textures/pulchr/five-steps-ahead-pindel.tga
	surfaceparm alphashadow
	surfaceparm nolightmap
	surfaceparm trans
	cull disable
	nopicmip
	{
		map textures/effects/tinfx2.tga
		blendfunc add
		rgbGen identity
		tcGen environment 
	}
	{
		map textures/pulchr/five-steps-ahead-pindel.tga
		depthWrite
		alphaFunc GE128
	}
	{
		map $lightmap 
		blendfunc filter
		rgbGen identity
		tcGen lightmap 
	}
}

textures/pulchr/fivestepsahead
{
	qer_editorimage textures/pulchr/five-steps-ahead.tga
	surfaceparm alphashadow
	surfaceparm nolightmap
	surfaceparm trans
	cull disable
	nopicmip
	{
		map textures/effects/tinfx2.tga
		blendfunc add
		rgbGen identity
		tcGen environment 
	}
	{
		map textures/pulchr/five-steps-ahead.tga
		depthWrite
		alphaFunc GE128
	}
	{
		map $lightmap 
		blendfunc filter
		rgbGen identity
		tcGen lightmap 
	}
}

textures/pulchr/teleenv
{
	deformVertexes wave 100 sin 3 0 0 0 
	q3map_surfacelight 400
	{
		map textures/pulchr/teleenv.tga
		blendfunc add
		tcMod rotate 30
		tcMod scroll 1 0.1
		tcGen environment 
	}
}

textures/pulchr/telefront
{
	qer_editorimage textures/pulchr/telepulchr.tga
	surfaceparm nodlight
	surfaceparm noimpact
	surfaceparm nomarks
	cull disable
	q3map_surfacelight 200
	{
		map textures/pulchr/telepulchr.tga
		blendfunc blend
	}
	{
		map textures/pulchr/tele-swirl.tga
		blendfunc add
		tcMod rotate -320
	}
	{
		map textures/pulchr/telepulchr.tga
		blendfunc add
		rgbGen wave inversesawtooth 0 0.5 0 0.25 
	}
}

textures/pulchr/teleback
{
	qer_editorimage textures/pulchr/back.tga
	surfaceparm nodlight
	surfaceparm noimpact
	surfaceparm nomarks
	q3map_surfacelight 200
	{
		map textures/pulchr/back.tga
		tcMod rotate 50
	}
	{
		map textures/pulchr/twirl.tga
		blendfunc blend
		tcMod rotate -540
	}
	{
		clampmap textures/pulchr/tele-swirl.tga
		blendfunc add
		tcMod rotate 573
	}
	{
		clampmap textures/pulchr/tele-swirl.tga
		blendfunc add
		tcMod rotate 573
		tcMod stretch sin 0.52 0 0 0 
	}
}

textures/pulchr/pul1duelsky
{
	qer_editorimage textures/pulchr/pul1duelsky-a.tga
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm sky
	q3map_lightsubdivide 64
	q3map_surfacelight 100
	q3map_globaltexture
	q3map_sun 0.94 0.9 0.6 50 45 80
	skyParms - 512 -
	{
		map textures/pulchr/pul1duelsky-a.tga
		tcMod scroll 0.045 0.055
		tcMod scale 3 2
		depthWrite
	}
	{
		map textures/pulchr/pul1duelsky-b.tga
		blendfunc add
		tcMod scroll 0.02 0.02
		tcMod scale 3 3
	}
}

textures/pulchr/airwalk
{
	qer_editorimage textures/pulchr/airwalk-env.tga
	surfaceparm nodlight
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm trans
	deformVertexes wave 128 sin 0 0 0 0 
	qer_trans 0.5
	q3map_surfacelight 200
	{
		map textures/pulchr/airwalk-env.tga
		blendfunc add
		tcMod rotate 30
		tcMod scroll 1 0.1
		tcGen environment 
	}
}

textures/pulchr/pulglass
{
	qer_editorimage textures/effects/tinfx2.tga
	surfaceparm nolightmap
	surfaceparm trans
	cull disable
	qer_trans 0.4
	{
		map textures/effects/tinfx2.tga
		blendfunc add
		rgbGen identity
		tcGen environment 
	}
}

textures/pulchr/listlight
{
	qer_editorimage textures/pulchr/listlight.tga
	surfaceparm nomarks
	q3map_surfacelight 800
	{
		map $lightmap 
		rgbGen identity
		tcGen lightmap 
	}
	{
		map textures/pulchr/listlight.tga
		blendfunc filter
		rgbGen identity
	}
	{
		map textures/pulchr/listlight_blend.tga
		blendfunc add
		rgbGen wave sin 0.25 0.75 0 0.25 
	}
}

