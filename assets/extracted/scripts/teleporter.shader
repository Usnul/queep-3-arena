teleptThis
{
	// used in kaos2, fixed square flickering (inversesawtooth glitch)
	surfaceparm nolightmap
	cull disable
	deformVertexes autosprite
	{
		clampmap textures/flares/newflare
		blendfunc add
		rgbGen wave triangle 0 1 0 1
		tcMod stretch inversesawtooth 0 1 0 2
		tcMod rotate 333
	}
	{
		clampmap textures/flares/lava
		blendfunc add
		rgbGen wave triangle 0 1 .5 1
		tcMod stretch inversesawtooth 0 1 0 2
		tcMod rotate -333
	}
	{
		clampmap textures/flares/newflare
		blendfunc add
		rgbGen wave triangle 0 1 .75 1.5 
		tcMod stretch sawtooth .2 .8 .5 2.5
		tcMod rotate 500
	}
	{
		clampmap textures/flares/portalflare
		blendfunc add
		rgbGen wave triangle 0 1 .5 2.5 
		tcMod stretch sawtooth .2 .8 0 4 
		tcMod rotate 1323
	}
}

teleptThat
{
	q3map_lightimage textures/effects/jumpcirc.tga
	surfaceparm nolightmap
	cull disable
	deformVertexes autosprite
	q3map_surfacelight 300
	{
		clampmap textures/effects/jumpcirc.tga
		blendfunc add
		rgbGen wave sawtooth 0 1 0 2 
		tcMod stretch inversesawtooth 0 1 0 2 
		tcMod rotate 333
	}
	{
		clampmap textures/effects/jumpcirc.tga
		blendfunc add
		rgbGen wave sawtooth 0 1 0 0.5 
		tcMod stretch inversesawtooth 0 1 0 0.5 
		tcMod rotate -333
	}
	{
		clampmap textures/effects/jumpcirc.tga
		blendfunc add
		rgbGen wave sawtooth 0 1 0 1.25 
		tcMod stretch inversesawtooth 0 1 0 1.25 
		tcMod rotate 500
	}
}

