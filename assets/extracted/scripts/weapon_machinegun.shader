machinegunFlash3
{
	cull disable
	{
		clampmap models/weapons2/machinegun/f_machinegun.tga
		blendfunc add
		rgbGen identity
		tcMod stretch sin 0.6 0.4 0 1 
		tcMod rotate 256
	}
	{
		clampmap models/weapons2/machinegun/f_machinegun.tga
		blendfunc add
		rgbGen identity
		tcMod stretch sin -0.6 0.4 0 1 
		tcMod rotate -256
	}
}

models/weapons2/machinegun/f_machinegun2
{
	cull disable
	{
		clampmap models/weapons2/machinegun/f_machinegun2.tga
		blendfunc add
		rgbGen identity
		tcMod rotate 5288
	}
}

models/weapons2/machinegun/f_machinegun3
{
	deformVertexes autosprite
	{
		clampmap models/weapons2/machinegun/f_machinegun3.tga
		blendfunc add
		rgbGen identity
		tcMod rotate 8288
	}
}

models/weapons2/machinegun/muzzlside
{
	cull disable
	{
		map models/weapons2/machinegun/muzzlside.tga
		blendfunc add
	}
}

models/weapons2/shells/mgunshell
{
	cull disable
	{
		map models/weapons2/shells/mgunshell.tga
		rgbGen lightingDiffuse
	}
	{
		map gfx/fx/spec/specenv.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		tcGen environment 
		alphaGen lightingSpecular
		detail
	}
}

models/weapons2/shells/mgunshell_2
{
	deformVertexes autosprite
	{
		clampmap models/weapons2/shells/mgunshell_2.tga
		blendfunc blend
		rgbGen lightingDiffuse
		tcMod scale 1.4 1.4
	}
}

shellCase
{
	cull disable
	{
		map models/weapons2/shells/sgunshell.tga
		rgbGen lightingDiffuse
	}
	{
		map gfx/fx/spec/specenv.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		tcGen environment 
		alphaGen lightingSpecular
		detail
	}
}

models/weapons2/machinegun/muzzlecenter
{
	deformVertexes autosprite
	{
		map models/weapons2/machinegun/f_machinegun.tga
		blendfunc add
		tcMod rotate 1246
	}
	{
		map models/weapons2/machinegun/f_machinegun.tga
		blendfunc add
		tcMod rotate -1246
	}
}

models/weapons2/machinegun/flare
{
	deformVertexes autosprite
	{
		map models/weapons2/machinegun/flare.tga
		blendfunc add
	}
}

models/weapons2/machinegun/skin
{
	{
		map models/weapons2/machinegun/mgun.tga
		rgbGen lightingDiffuse
	}
	{
		map gfx/fx/detail/d_met.tga
		blendfunc gl_dst_color gl_src_color
		tcMod scale 8 8
		detail
	}
	{
		map gfx/fx/spec/gunmetal.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		tcGen environment 
		alphaGen lightingSpecular
		detail
	}
	{
		map models/weapons2/machinegun/mgun.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/weapons2/machinegun/sight
{
	cull disable
	{
		map models/weapons2/machinegun/sight.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

