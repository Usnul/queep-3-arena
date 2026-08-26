// Q3 compatible shaders

textures/sfx/portal_sfx_ring
{
	deformVertexes wave 25 sin 3 2 .5 3 // same as sfx/portal_sfx
	
	{
		map textures/sfx/portal_sfx_ring_blue1
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		rgbGen identity
	}
	{
		map textures/sfx/portal_sfx_ring_electric
		blendFunc add
		rgbGen wave sin 0 .5 .25 .5
		tcMod scroll 0 .5
	}
	{
		map textures/sfx/portal_sfx1
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		tcMod rotate 360
	}
	{
		map textures/sfx/portal_sfx_ring
		blendFunc add
		rgbGen wave sin 0 .5 .25 .5
	}
}

// Q3 compatible fog shaders taken from oa_fog.shader

textures/sfx/hellfog_pj_dm10
{
	qer_editorimage textures/sfx/hellfog
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.6 0.1 0.1 ) 500
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod scroll -.02 .02
	}
}

textures/sfx/hellfog_mini_dm10
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.6 0.1 0.1 ) 20
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scroll -.02 .02
	}
}

textures/sfx/hellfog_tim_dm14
{
	qer_editorimage textures/sfx/hellfog
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.6 0.1 0.1 ) 200
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod scroll -.02 .02
	}
}

textures/sfx/kc_hellfog_1k
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.65098 0.07451 0.11372 ) 200
	q3map_surfacelight 1000
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod scroll -0.23 -0.3
	}
}

// obsolete?
textures/sfx/hellfog_1k
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.65098 0.07451 0.11372 ) 300
	q3map_surfacelight 1000
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod scroll -0.23 -0.3
	}
}

// obsolete?
textures/sfx/hellfog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.65098 0.07451 0.11372 ) 300
	q3map_surfacelight 1000
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcmod scale -.1 -.1
		tcMod scroll -0.23 -0.3
	}
}

// obsolete?
textures/sfx/constfog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.6 0.6 0.6 ) 200
}

textures/sfx/q3tourney3fog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.6 0.12 0.1 ) 300
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1 
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1 
		tcMod scroll -.02 .02
	}
}

textures/sfx/q3dm9fog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.47843 0.086275 0.086275 ) 500
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod scroll -.02 .02
	}
}

textures/sfx/q3dm14fog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.72157 0.13 0.13 ) 300
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod scroll -.02 .02
	}
}

// added 1-19-2007 for backwards compat. with q3a
// and we needed a red fog :)
textures/sfx/hellfogdense
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.65098 0.07451 0.11372 ) 100
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod scroll -0.23 -0.3
	}
}


textures/sfx/xlightgreyfog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
	surfaceparm nolightmap
	fogparms ( 0.5 0.5 0.5 ) 800
}

textures/sfx/xdensegreyfog
{
        surfaceparm trans
        surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
	surfaceparm nolightmap
        fogparms ( 0.5 0.5 0.5 ) 1000
}

textures/sfx/xfinalfog
{
        surfaceparm trans
        surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
	surfaceparm nolightmap
        fogparms ( 0 0 0 ) 400
}

textures/sfx/xbluefog
{
        surfaceparm trans
        surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
        cull disable
        fogparms ( 0.13 0.13 0.73 ) 128
}

textures/sfx/xredfog
{
        surfaceparm trans
        surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
        cull disable
        fogparms ( 0.73 0.13 0.13 ) 500
}

textures/sfx/fog_timdm1
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	//fogparms ( 0.67059 0.48235 0.21961 ) 500
	fogparms ( 0.62 0.36 0 ) 520
}

textures/sfx/fog_timdm2
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.48 0.25 0 ) 300
}

// obsolete?
textures/sfx/fog_timdm8
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.2 0.2 0 ) 500
}

textures/sfx/fog_timctf1
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.7 0.7 0.72 ) 300
	
}

textures/sfx/fog_pjdm1
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.7 0.7 0.6 ) 400
}

textures/sfx/fog_intel
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.65098 0.07451 0.11372 ) 300	
}

textures/sfx/proto_hellfog

{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.65098 0.07451 0.11372 ) 500
}

// obsolete?
textures/sfx/fog_q3dm10
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.78431 0.82353 0.00392 ) 128
}

textures/sfx/mkc_fog_tdm3
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.47058 0.13725 0.14509 ) 500
	
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod scroll -.02 .02
	}
}

textures/sfx/mkc_fog_ctfred
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.6 0.3 0.3 ) 300
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod scroll -.02 .02
	}
}

textures/sfx/mkc_fog_ctfblue
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.3 0.3 0.4 ) 300
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale 0.1 0.1
		tcMod scroll -.02 .02
	}
}

textures/sfx/mkc_fog_ctfblue2
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.3 0.3 0.6 ) 300
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale -0.1 -0.1
		tcMod turb .01 .5 0 .05
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scale 0.1 0.1
		tcMod scroll -.02 .02
	}	
}


