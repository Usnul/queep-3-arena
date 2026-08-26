models/players/angelyss/retro
{
	{
		map models/players/angelyss/retro.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/angelyss/retro.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/clothes
{
	cull disable
	{
		map models/players/hnt/clothes.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/clothes.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/angelyss/retroclothes
{
	cull disable
	{
		map models/players/angelyss/retroclothes.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/robawt.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/angelyss/hair_retro
{
	cull disable
	{
		map models/players/angelyss/retro.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/neko1
{
	cull disable
	{
		map models/players/hnt/neko1.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/neko4
{
	{
		map models/players/hnt/neko1.tga
		rgbGen lightingDiffuse
	}
}

models/players/hnt/redneko4
{
	{
		map models/players/hnt/redneko1.tga
		rgbGen lightingDiffuse
	}
}

models/players/hnt/redneko1
{
	cull disable
	{
		map models/players/hnt/redneko1.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/blueneko1
{
	cull disable
	{
		map models/players/hnt/blueneko1.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/blueneko4
{
	{
		map models/players/hnt/blueneko1.tga
		rgbGen lightingDiffuse
	}
}

models/players/hnt/neko2
{
	cull disable
	{
		map models/players/hnt/neko2.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/blueneko2
{
	cull disable
	{
		map models/players/hnt/blueneko2.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/redneko2
{
	cull disable
	{
		map models/players/hnt/redneko2.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/drkclothes
{
	cull disable
	{
		map models/players/hnt/drkclothes.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/robawt.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkclothes_red
{
	cull disable
	{
		map models/players/hnt/drkclothes_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/drkclothes_red.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/gldclothes
{
	cull disable
	{
		map models/players/hnt/gldclothes.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/gldclothes.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/azsuit
{
	{
		map models/players/hnt/azskin.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/suitchrome.tga
		blendfunc add
		rgbGen lightingDiffuse
		tcGen environment 
	}
	{
		map models/players/hnt/azskin.tga
		blendfunc blend
		rgbGen lightingDiffuse
	}
}

models/players/hnt/redclothes
{
	cull disable
	{
		map models/players/hnt/redclothes.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/redclothes.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/hair
{
	cull disable
	{
		map models/players/hnt/skin.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/hair_red
{
	cull disable
	{
		map models/players/hnt/skin_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/hair_blue
{
	cull disable
	{
		map models/players/hnt/skin_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/skin
{
	{
		map models/players/hnt/skin.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/skin.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/skin_blue
{
	{
		map models/players/hnt/skin_blue.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/skin_blue.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/skin_red
{
	{
		map models/players/hnt/skin_red.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/skin_red.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkskin
{
	{
		map models/players/hnt/drkskin.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/drkskin.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkskin_blue
{
	{
		map models/players/hnt/drkskin_blue.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/drkskin_blue.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkskin_red
{
	{
		map models/players/hnt/drkskin_red.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/drkskin_red.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkhair
{
	cull disable
	{
		map models/players/hnt/drkskin.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/hairspecmask.tga
		blendfunc gl_dst_color gl_dst_alpha
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
	}
}

models/players/hnt/drkhair_blue
{
	cull disable
	{
		map models/players/hnt/drkskin_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkhair_red
{
	cull disable
	{
		map models/players/hnt/drkskin_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/gldhair
{
	cull disable
	{
		map models/players/hnt/gldskin.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/redhair
{
	cull disable
	{
		map models/players/hnt/azskin.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/slyclothes
{
	cull disable
	{
		map models/players/hnt/sly2.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

// TEAM SKIN EXPLOSION
models/players/hnt/clothes_blue
{
	cull disable
	{
		map models/players/hnt/clothes_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/clothes_blue.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/clothes_red
{
	cull disable
	{
		map models/players/hnt/clothes_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/clothes_red.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/drkclothes_blue
{
	cull disable
	{
		map models/players/hnt/drkclothes_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/drkclothes_blue.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/gldclothes_red
{
	cull disable
	{
		map models/players/hnt/gldclothes_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/gldclothes_red.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/redclothes_blue
{
	cull disable
	{
		map models/players/hnt/redclothes_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/redclothes_blue.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/redclothes_gray
{
	cull disable
	{
		map models/players/hnt/redclothes_gray.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hnt/redclothes_gray.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/hair
{
	cull disable
	{
		map models/players/hnt/skin.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/gldhair_red
{
	cull disable
	{
		map models/players/hnt/gldskin_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map gfx/fx/spec/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/redhair_blue
{
	cull disable
	{
		map models/players/hnt/azskin_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
	{
		map models/players/hairspec.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		tcGen environment 
		depthFunc equal
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/slyclothes_blue
{
	cull disable
	{
		map models/players/hnt/sly2_blue.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/slyclothes_red
{
	cull disable
	{
		map models/players/hnt/sly2_red.tga
		rgbGen lightingDiffuse
		alphaFunc GE128
	}
}

models/players/hnt/azsuit_blue
{
	{
		map models/players/hnt/azskin_blue.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/suitchrome.tga
		blendfunc add
		rgbGen lightingDiffuse
		tcGen environment 
	}
	{
		map models/players/hnt/azskin_blue.tga
		blendfunc blend
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/azskin_blue.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

models/players/hnt/azsuit_red
{
	{
		map models/players/hnt/azskin_red.tga
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/suitchrome.tga
		blendfunc add
		rgbGen lightingDiffuse
		tcGen environment 
	}
	{
		map models/players/hnt/azskin_red.tga
		blendfunc blend
		rgbGen lightingDiffuse
	}
	{
		map models/players/hnt/azskin_red.tga
		blendfunc gl_src_alpha gl_one
		rgbGen lightingDiffuse
		alphaGen lightingSpecular
		detail
	}
}

