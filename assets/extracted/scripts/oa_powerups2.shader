invulitem1
{
	cull disable
	{
		map gfx/fx/spec/spots.tga
		blendfunc add
		rgbGen const ( 0.74902 0.301961 0.537255 )
		tcMod scroll 1 1
		tcGen environment 
	}
	{
		map gfx/fx/spec/spots.tga
		blendfunc gl_src_alpha gl_one
		rgbGen const ( 0.470588 0.105882 0.686275 )
		tcMod scroll 1 1
		tcGen environment 
		alphaGen lightingSpecular
	}
}

invulitem2
{
	{
		map textures/effects/tinfx2c.tga
		rgbGen identity
		tcMod rotate 74
		tcGen environment 
	}
}

shieldjuiced
{
	cull disable
	{
		map models/powerups/shield/juiced-drip.tga
		tcMod scroll 0 -0.12
		tcMod turb 0 0.01 0 0.1
		alphaFunc GE128
		alphaGen wave inversesawtooth 0.4 1 0 0.2 
		detail
	}
	{
		map models/powerups/shield/juiced-drip.tga
		tcMod scroll 0 -0.1
		tcMod turb 0 0.02 0 0.03
		tcMod scale -1 1
		alphaFunc GE128
		alphaGen wave inversesawtooth 0.4 1 0 0.2 
		detail
	}
	{
		map models/powerups/shield/juiced-splat.tga
		tcMod scroll 0 -0.01
		alphaFunc GE128
		alphaGen wave inversesawtooth 0 1 0 0.2 
	}
	{
		map textures/effects/envmapred.tga
		blendfunc blend
		rgbGen lightingDiffuse
		tcGen environment 
		alphaGen wave sin 0.5 0 0 1 
	}
}

shieldsphere
{
	cull disable
	{
		map gfx/fx/spec/robawt.tga
		blendfunc gl_src_alpha gl_one
		rgbGen const ( 0.184314 0.152941 0.239216 )
		tcMod rotate 167
		tcMod scale 0.2 0.2
		tcGen environment 
		alphaGen lightingSpecular
	}
	{
		map models/powerups/shield/shieldwire.tga
		blendfunc gl_src_alpha gl_one
		alphaGen wave sin 0.1 0 0 0.1 
		detail
	}
	{
		map gfx/fx/detail/d_sand.tga
		blendfunc gl_dst_color gl_one
		tcMod scroll 0 -0.5
		detail
	}
}

shieldimpact
{
	cull disable
	{
		map models/powerups/shield/impact.tga
		blendfunc add
		rgbGen wave inversesawtooth 0 1 0 1 
		tcMod rotate -32
		tcMod stretch sawtooth 1 2 0 1 
	}
}

