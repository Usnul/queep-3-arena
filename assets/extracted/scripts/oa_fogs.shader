textures/fogs/fogyou
{
		surfaceparm trans
		surfaceparm nonsolid
		surfaceparm fog
		surfaceparm nolightmap
	cull disable
	fogparms ( 0.458824 0.862745 0.411765 ) 666
}

textures/fogs/fogoff
{
		surfaceparm trans
		surfaceparm nonsolid
		surfaceparm fog
		surfaceparm nolightmap
	cull disable
	fogparms ( 0.458824 0.862745 0.411765 ) 666
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scroll 0.3 0.2
	}
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod scroll -0.23 -0.3
	}
}

textures/sfx/hellfog_mini_dm10
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.458824 0.862745 0.411765 ) 300
	
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

textures/sfx/xblackfog
{
        surfaceparm trans
        surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
        cull disable
        fogparms ( 0.05 0.05 0.05 ) 500
}

textures/fogs/fog_orange
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	cull disable
	fogparms ( 0.5 0.2 0.0 ) 512
	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc filter
		tcMod turb 1 -0.3 0 0.07
		tcMod scale 0.2 0.2
	}
}

textures/sfx2/ouchfog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	q3map_globaltexture
	cull none
	fogparms ( 1 0 0 ) 50
	{
		map textures/skies/s2.tga
		blendfunc filter
		tcmod scale 0.4 0.4
		tcmod turb .01 .5 0 .05
	}
}

textures/sfx2/dist_fog
{
	surfaceparm trans
	surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nolightmap
	q3map_globaltexture
	cull none
	fogparms ( .05 .04 .03 ) 256
}

textures/sfx/xnotsodensegreyfog
{
        surfaceparm trans
        surfaceparm nonsolid
	surfaceparm fog
	surfaceparm nomarks
        cull disable
        fogparms ( 0.4784 0.4784 0.4784 ) 600
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

