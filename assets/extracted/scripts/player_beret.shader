models/players/beret/cooldude
{
	{
		map models/players/beret/cooldude.tga
		rgbGen lightingDiffuse
		tcGen environment 
	}
}

models/players/beret/headcrash1
{
	{
		map models/players/beret/headcrash1.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/beret/spec_headcrash1.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/beret/skin1
{
	{
		map models/players/beret/skin1.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/beret/spec_skin1.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/beret/skin1blue
{
	{
		map models/players/beret/skin1blue.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/beret/spec_skin1.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/beret/skin1red
{
	{
		map models/players/beret/skin1red.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/beret/spec_skin1.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/beret/headcrash2
{
	{
		map models/players/beret/headcrash1.tga
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
	}
	{
		map textures/oafx/flare.tga
		blendfunc gl_src_alpha gl_one
		tcMod rotate 4
		tcGen environment 
		alphaGen lightingSpecular
	}
}

